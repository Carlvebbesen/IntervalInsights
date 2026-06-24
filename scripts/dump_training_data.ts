import { sleep } from "bun";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getIntervalsAccessToken } from "../src/middlewares/intervals_middleware";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import * as schema from "../src/schema";
import { intervalsApiService } from "../src/services/intervals_api_service";
import {
  extractIntervalsList,
  mapIntervalsRawToLaps,
  mapIntervalsStreamsToStreamSet,
} from "../src/services/intervals_mappers";
import { stravaApiService } from "../src/services/strava_api_service";

/**
 * Activity training-data dump — builds the evaluation corpus for the analyze flow.
 *
 * WHY each block is captured (every field is here for a verification reason; nothing speculative):
 *  - db.activity        — the full row INCLUDING `draftAnalysisResult` (the LLM's classification,
 *                         confidence_score, proposed structure, proposed segments, and the
 *                         intervals.icu prediction). This is the model OUTPUT we grade.
 *  - db.intervalSegments— the persisted per-segment breakdown = the final committed result.
 *  - db.intervalStructure— the deduped workout shape + signature (drives propose-pace history match).
 *  - db.events          — health events detected by the tail node (detectEvents).
 *  - pipeline.streams   — the time-series the segmenter/classifier actually consume, fetched via the
 *                         SAME clients + mappers the controllers use (intervals.icu-preferred, Strava
 *                         fallback). This is the model INPUT.
 *  - pipeline.laps      — device/intervals laps the lap-derivation rung consumes.
 *  - pipeline.splits    — per-km splits (Strava only).
 *  - intervalsIcuRaw    — GROUND TRUTH: intervals.icu's own WORK/RECOVERY blocks (`iv.type`, which the
 *                         Lap mapping drops) + its predicted activity type. The top segmentation rung
 *                         trusts these; we keep them raw to grade rung 1 against truth.
 *
 * Runs IN-PROCESS using the local .env (CLERK_SECRET_KEY resolves OAuth tokens from Clerk metadata),
 * mirroring scripts/backfill_hr_stats.ts — no short-lived bearer token needed. Streams/laps are NOT
 * in Postgres, so they must be fetched live; everything else is read straight from the dev DB.
 *
 * Env: OUT_DIR, LIMIT, ONLY_ID, USER_EMAIL (filter), DELAY_MS (throttle), DRY_RUN=1 (DB only, no API).
 * Run: cd interval-insights/interval-insights && OUT_DIR=... bun run scripts/dump_training_data.ts
 */

const OUT_DIR =
  process.env.OUT_DIR ??
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";
const MODE = process.env.MODE ?? "curated"; // "curated" = all v4.0 activities + a stratified v1.0 run sample; "all" = every activity
const SAMPLE_N = Number(process.env.SAMPLE_N ?? 20);
const DELAY_MS = Number(process.env.DELAY_MS ?? 400);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const ONLY_ID = process.env.ONLY_ID ? Number(process.env.ONLY_ID) : null;
const USER_EMAIL = process.env.USER_EMAIL ?? null;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

const RICH_STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
] as const;

function flattenStreamSet(s: any) {
  const at = (k: string) => s?.[k]?.data ?? null;
  return {
    time: at("time") ?? [],
    distance: at("distance") ?? [],
    heartrate: at("heartrate"),
    velocity: at("velocity_smooth"),
    altitude: at("altitude"),
    cadence: at("cadence"),
    watts: at("watts"),
    latlng: at("latlng"),
    moving: at("moving"),
    grade: at("grade_smooth"),
    temp: at("temp"),
  };
}

async function main() {
  console.log(
    `[dump] out=${OUT_DIR} limit=${LIMIT ?? "ALL"} onlyId=${ONLY_ID ?? "-"} user=${USER_EMAIL ?? "ALL"} dryRun=${DRY_RUN}`,
  );

  const userRows = await db
    .select({
      id: schema.users.id,
      clerkId: schema.users.clerkId,
      email: (schema.users as any).email ?? schema.users.clerkId,
      maxHeartRate: (schema.users as any).maxHeartRate ?? schema.users.id,
      processHeartRate: (schema.users as any).processHeartRate ?? schema.users.id,
    })
    .from(schema.users);
  const userById = new Map(userRows.map((u) => [u.id, u]));

  let acts = await db
    .select()
    .from(schema.activities)
    .orderBy(asc(schema.activities.startDateLocal));

  if (ONLY_ID) acts = acts.filter((a) => a.id === ONLY_ID);
  if (USER_EMAIL) {
    const uid = userRows.find((u) => (u as any).email === USER_EMAIL)?.id;
    acts = acts.filter((a) => a.userId === uid);
  }
  if (MODE === "curated" && !ONLY_ID) {
    const v40 = acts.filter((a) => (a as any).analysisVersion === "v4.0");
    const v40ids = new Set(v40.map((a) => a.id));
    const runs = acts
      .filter((a) => !v40ids.has(a.id) && /run/i.test(String((a as any).sportType)))
      .sort((x, y) => Number((x as any).distance) - Number((y as any).distance));
    const sample: typeof runs = [];
    const step = Math.max(1, Math.floor(runs.length / Math.max(1, SAMPLE_N)));
    for (let k = 0; k < runs.length && sample.length < SAMPLE_N; k += step) sample.push(runs[k]);
    acts = [...v40, ...sample].sort(
      (x, y) => +new Date((x as any).startDateLocal) - +new Date((y as any).startDateLocal),
    );
    console.log(`[dump] curated: ${v40.length} v4.0 + ${sample.length} sampled v1.0 runs = ${acts.length}`);
  }
  if (LIMIT) acts = acts.slice(0, LIMIT);

  console.log(`[dump] activities to dump: ${acts.length}`);

  const stravaTokenCache = new Map<string, string | null>();
  const intervalsTokenCache = new Map<string, string | null>();
  async function stravaTokenFor(clerkId: string): Promise<string | null> {
    if (stravaTokenCache.has(clerkId)) return stravaTokenCache.get(clerkId) ?? null;
    try {
      const t = (await getStravaAccessTokens(clerkId)).access_token;
      stravaTokenCache.set(clerkId, t);
      return t;
    } catch {
      stravaTokenCache.set(clerkId, null);
      return null;
    }
  }
  async function intervalsTokenFor(clerkId: string): Promise<string | null> {
    if (intervalsTokenCache.has(clerkId)) return intervalsTokenCache.get(clerkId) ?? null;
    try {
      const t = await getIntervalsAccessToken(clerkId);
      intervalsTokenCache.set(clerkId, t);
      return t;
    } catch {
      intervalsTokenCache.set(clerkId, null);
      return null;
    }
  }

  const manifest: any[] = [];
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < acts.length; i++) {
    const act = acts[i] as any;
    const user = userById.get(act.userId);
    const clerkId = user?.clerkId as string | undefined;
    const errors: string[] = [];

    // ---- DB-side (always, no API) ----
    const segments = await db
      .select()
      .from(schema.intervalSegments)
      .where(eq(schema.intervalSegments.activityId, act.id))
      .orderBy(asc(schema.intervalSegments.segmentIndex));

    let structure: unknown = null;
    if (act.intervalStructureId) {
      structure =
        (
          await db
            .select()
            .from(schema.intervalStructures)
            .where(eq(schema.intervalStructures.id, act.intervalStructureId))
        )[0] ?? null;
    }

    let eventsDump: unknown[] = [];
    try {
      const ae: any = (schema as any).activityEvents;
      const ev: any = (schema as any).events;
      const at: any = (schema as any).eventAttributes;
      if (ae && ev) {
        const links = await db.select().from(ae).where(eq(ae.activityId, act.id));
        const evIds = links.map((l: any) => l.eventId);
        if (evIds.length) {
          const evs = await db.select().from(ev).where(inArray(ev.id, evIds));
          const attrs = at
            ? await db.select().from(at).where(inArray(at.eventId, evIds))
            : [];
          eventsDump = evs.map((e: any) => ({
            ...e,
            attributes: attrs.filter((a: any) => a.eventId === e.id),
          }));
        }
      }
    } catch (e) {
      errors.push(`events: ${e instanceof Error ? e.message : String(e)}`);
    }

    const source = act.intervalsIcuId
      ? { kind: "intervals" as const, externalId: act.intervalsIcuId }
      : act.stravaActivityId != null
        ? { kind: "strava" as const, externalId: Number(act.stravaActivityId) }
        : { kind: "none" as const };

    // ---- Live API-side (skipped in DRY_RUN) ----
    let pipeline: any = { streams: null, laps: null, splits: null };
    let intervalsIcuRaw: any = null;
    let stravaRaw: any = null;

    if (!DRY_RUN && clerkId) {
      try {
        if (source.kind === "intervals") {
          const itoken = await intervalsTokenFor(clerkId);
          if (!itoken) throw new Error("no intervals.icu token");
          const rawStreams = await intervalsApiService.getActivityStreams(
            itoken,
            source.externalId,
            RICH_STREAM_KEYS as unknown as string[],
          );
          const rawIntervals = await intervalsApiService.getActivityIntervals(
            itoken,
            source.externalId,
          );
          const icuActivity = await intervalsApiService.getActivity(itoken, source.externalId);
          pipeline.streams = flattenStreamSet(mapIntervalsStreamsToStreamSet(rawStreams));
          pipeline.laps = mapIntervalsRawToLaps(rawIntervals);
          pipeline.splits = [];
          intervalsIcuRaw = {
            activity: icuActivity,
            intervalsWrapper: rawIntervals,
            intervals: extractIntervalsList(rawIntervals),
            streamsRaw: rawStreams,
          };
        } else if (source.kind === "strava") {
          const stoken = await stravaTokenFor(clerkId);
          if (!stoken) throw new Error("no Strava token");
          const rawStreams = await stravaApiService.getActivityStreams(
            stoken,
            source.externalId,
            RICH_STREAM_KEYS as any,
          );
          const laps = await stravaApiService.getActivityLaps(stoken, source.externalId);
          const detail = await stravaApiService.getActivity(stoken, source.externalId);
          pipeline.streams = flattenStreamSet(rawStreams);
          pipeline.laps = laps;
          pipeline.splits = (detail as any).splits_metric ?? [];
          stravaRaw = { detail, streamsRaw: rawStreams };
        }
      } catch (e) {
        errors.push(`fetch: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const dump = {
      capturedAt: new Date().toISOString(),
      activityId: act.id,
      source,
      user: user
        ? {
            clerkId: user.clerkId,
            maxHeartRate: (user as any).maxHeartRate ?? null,
            processHeartRate: (user as any).processHeartRate ?? null,
          }
        : null,
      db: {
        activity: act,
        intervalSegments: segments,
        intervalStructure: structure,
        events: eventsDump,
      },
      pipeline,
      intervalsIcuRaw,
      stravaRaw,
      errors,
    };

    try {
      await Bun.write(`${OUT_DIR}/activity-${act.id}.json`, JSON.stringify(dump, jsonReplacer, 2));
      ok++;
    } catch (e) {
      failed++;
      errors.push(`write: ${e instanceof Error ? e.message : String(e)}`);
    }

    const draft: any = act.draftAnalysisResult ?? {};
    manifest.push({
      id: act.id,
      title: act.title,
      sportType: act.sportType,
      trainingType: act.trainingType,
      analysisStatus: act.analysisStatus,
      analysisVersion: act.analysisVersion,
      classifiedType: draft?.training_type ?? draft?.analysis?.training_type ?? null,
      confidenceScore: draft?.confidence_score ?? draft?.analysis?.confidence_score ?? null,
      proposedSegmentCount: Array.isArray(draft?.proposedSegments)
        ? draft.proposedSegments.length
        : null,
      startDateLocal: act.startDateLocal,
      distance: act.distance,
      movingTime: act.movingTime,
      indoor: act.indoor,
      hasHeartrate: act.hasHeartrate,
      stravaActivityId: act.stravaActivityId != null ? String(act.stravaActivityId) : null,
      intervalsIcuId: act.intervalsIcuId,
      source: source.kind,
      lapCount: Array.isArray(pipeline.laps) ? pipeline.laps.length : null,
      streamLen: Array.isArray(pipeline.streams?.time) ? pipeline.streams.time.length : null,
      streamHasHr: pipeline.streams?.heartrate != null,
      icuBlockCount: Array.isArray(intervalsIcuRaw?.intervals)
        ? intervalsIcuRaw.intervals.length
        : null,
      segmentCount: segments.length,
      errorCount: errors.length,
    });

    console.log(
      `[dump] ${i + 1}/${acts.length} id=${act.id} "${String(act.title).slice(0, 32)}" type=${act.trainingType} src=${source.kind} laps=${manifest.at(-1)?.lapCount ?? "-"} streamLen=${manifest.at(-1)?.streamLen ?? "-"} segs=${segments.length} errs=${errors.length}`,
    );

    if (!DRY_RUN && i < acts.length - 1) await sleep(DELAY_MS);
  }

  await Bun.write(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, jsonReplacer, 2));
  console.log(`[dump] done. wrote=${ok} failed=${failed} manifest=${OUT_DIR}/manifest.json`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("[dump] fatal:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
