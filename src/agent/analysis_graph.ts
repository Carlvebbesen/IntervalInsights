import type { RunnableConfig } from "@langchain/core/runnables";
import { END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { sleep } from "bun";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type * as schema from "../schema";
import {
  activities,
  activityEvents,
  determineIntervalType,
  eventAttributes,
  events,
  generateIntervalSignature,
  generateStructureName,
  type InsertEvent,
  type InsertEventAttribute,
  intervalSegments,
  intervalStructures,
  mapSegmentsToComponents,
} from "../schema";
import type { AttributeValueType, EventType, TrainingType } from "../schema/enums";
import { userHasHeartRateConsent } from "../services.ts/heart_rate_consent_service";
import { stravaApiService } from "../services.ts/strava_api_service";
import {
  calculateSegmentStats,
  couldSkipCompleteAnalysis,
  lapsMatchIntervals,
  needCompleteAnalysis,
  parsePaceStringToMetersPerSecond,
} from "../services.ts/utils";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import {
  type EventAttributeOutput,
  invokeEventDetectionAgent,
  type KnownAttributeKey,
} from "./event_detection_agent";
import { invokeCompleteActivityAnalysisAgent } from "./full_analysis_agent";
import { type AnalysisState, AnalysisStateAnnotation } from "./graph_state";
import { invokeActivityAnalysisAgent } from "./initial_analysis_agent";

type Db = NodePgDatabase<typeof schema>;
type Configurable = { db: Db; stravaAccessToken: string };

async function invokeWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error as { message?: string; status?: number; retryDelay?: string };
    const msg = err?.message ?? "";
    const isRateLimit = err?.status === 429 || msg.includes("429");
    if (!isRateLimit) throw error;

    let waitMs = 10_000;
    const retryMatch = msg.match(/retry in ([\d.]+)s/);
    if (retryMatch?.[1]) {
      waitMs = Math.ceil(Number.parseFloat(retryMatch[1]) * 1000) + 2000;
    } else if (err?.retryDelay) {
      waitMs = Number.parseInt(err.retryDelay, 10) * 1000 + 2000;
    }
    console.warn(`Gemini quota exceeded. Waiting ${waitMs}ms before retry.`);
    await sleep(waitMs);
    return fn();
  }
}

async function classifyActivity(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken } = config.configurable as Configurable;

  const activity = await stravaApiService.getActivity(stravaAccessToken, state.stravaActivityId);
  const processHeartRate = await userHasHeartRateConsent(db, state.userId);
  const streamKeys = processHeartRate
    ? (["time", "velocity_smooth", "heartrate", "distance", "moving"] as const)
    : (["time", "velocity_smooth", "distance", "moving"] as const);
  const streams = await stravaApiService.getActivityStreams(
    stravaAccessToken,
    state.stravaActivityId,
    [...streamKeys],
  );

  if (!streams || Object.keys(streams).length === 0) {
    throw new Error(`No streams returned for activity ${state.stravaActivityId}`);
  }

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_init" })
    .where(eq(activities.id, state.activityId));

  const initialResult = await invokeWithRateLimitRetry(() =>
    invokeActivityAnalysisAgent(
      streams,
      activity.name,
      activity.description ?? "-",
      activity.total_elevation_gain,
      activity.type,
    ),
  );

  if (!initialResult) {
    throw new Error("Initial analysis agent returned null");
  }

  const canSkipComplete = couldSkipCompleteAnalysis(initialResult);
  const isIndoor = activity.trainer ?? false;

  let lapsMatchStructure = false;
  if (!canSkipComplete && needCompleteAnalysis(initialResult.training_type) && !isIndoor) {
    const laps = await stravaApiService.getActivityLaps(stravaAccessToken, state.stravaActivityId);
    lapsMatchStructure = lapsMatchIntervals(laps, initialResult);
  }

  await db
    .update(activities)
    .set({
      analyzedAt: new Date(),
      analysisStatus: "initial",
      draftAnalysisResult: initialResult,
      analysisVersion: "v3.0",
    })
    .where(eq(activities.id, state.activityId));

  return {
    initialResult,
    canSkipComplete,
    lapsMatchStructure,
    isIndoor,
    activityTitle: activity.name ?? "",
    activityDescription: activity.description ?? "",
    activityStartDateLocal: new Date(activity.start_date_local),
  };
}

async function markCompleted(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  await db
    .update(activities)
    .set({
      trainingType: state.initialResult?.training_type,
      analysisStatus: "completed",
      draftAnalysisResult: null,
    })
    .where(eq(activities.id, state.activityId));

  return {};
}

async function awaitUserInput(state: AnalysisState): Promise<Partial<AnalysisState>> {
  const tag = `[awaitUserInput activity=${state.activityId}]`;
  console.log(`${tag} entering interrupt (or resuming with payload)`);
  const userInput = interrupt({
    initialResult: state.initialResult,
    activityId: state.activityId,
  }) as { notes: string; sets: ExpandedIntervalSet[]; trainingType: string | null };

  console.log(
    `${tag} resumed with notes.len=${userInput?.notes?.length ?? 0} sets=${userInput?.sets?.length ?? 0} trainingType=${userInput?.trainingType ?? "null"}`,
  );
  return {
    userNotes: userInput.notes ?? "",
    userSets: userInput.sets ?? [],
    confirmedTrainingType: (userInput.trainingType as TrainingType | null) ?? null,
  };
}

async function runCompleteAnalysis(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken } = config.configurable as Configurable;
  const tag = `[runCompleteAnalysis activity=${state.activityId}]`;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  console.log(
    `${tag} start trainingType=${trainingType} confirmedFromUser=${state.confirmedTrainingType ?? "null"} userSets=${state.userSets?.length ?? 0} userNotes.len=${state.userNotes?.length ?? 0}`,
  );
  if (!trainingType) {
    throw new Error("runCompleteAnalysis called without a resolved trainingType");
  }

  if (!needCompleteAnalysis(trainingType)) {
    console.log(`${tag} trainingType=${trainingType} skips LLM segment breakdown`);
    await db
      .update(activities)
      .set({
        analysisStatus: "completed",
        notes: state.userNotes,
        trainingType,
        draftAnalysisResult: null,
      })
      .where(eq(activities.id, state.activityId));
    return { computedSegments: [] };
  }

  const processHeartRate = await userHasHeartRateConsent(db, state.userId);
  const streamKeys = processHeartRate
    ? (["time", "velocity_smooth", "heartrate", "distance", "moving"] as const)
    : (["time", "velocity_smooth", "distance", "moving"] as const);
  console.log(`${tag} fetching streams + laps from Strava (hr=${processHeartRate})`);
  const streams = await stravaApiService.getActivityStreams(
    stravaAccessToken,
    state.stravaActivityId,
    [...streamKeys],
  );
  const laps = await stravaApiService.getActivityLaps(stravaAccessToken, state.stravaActivityId);
  console.log(
    `${tag} streams keys=[${streams ? Object.keys(streams).join(",") : "none"}] timePoints=${streams?.time?.data?.length ?? 0} laps=${laps?.length ?? 0}`,
  );

  if (!streams || Object.keys(streams).length === 0) {
    throw new Error(`No streams returned for activity ${state.stravaActivityId}`);
  }

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_completed" })
    .where(eq(activities.id, state.activityId));

  console.log(`${tag} invoking complete analysis LLM`);
  const segmentPlan = await invokeWithRateLimitRetry(() =>
    invokeCompleteActivityAnalysisAgent(
      streams,
      state.userNotes,
      trainingType,
      laps,
      state.initialResult,
      state.userSets,
    ),
  );

  if (!segmentPlan) {
    console.error(`${tag} LLM returned null — see "Failed to analyze activity" log above`);
    throw new Error("Complete analysis agent returned null");
  }
  console.log(`${tag} LLM returned ${segmentPlan.segments.length} raw segments`);

  let segmentIndexCounter = 0;
  let droppedByStats = 0;
  const computedSegments = segmentPlan.segments
    .map((seg) => {
      const stats = calculateSegmentStats(streams, seg.start_time, seg.end_time);
      if (!stats) {
        droppedByStats += 1;
        return null;
      }
      return {
        activityId: state.activityId,
        segmentIndex: segmentIndexCounter++,
        setGroupIndex: seg.set_group_index ?? 0,
        type: seg.type,
        targetType: seg.target_type,
        targetValue: seg.target_value,
        targetPace: parsePaceStringToMetersPerSecond(seg.target_pace_string ?? ""),
        timeSeriesEndTime: stats.timeSeriesEndTime,
        actualDistance: stats.actualDistance,
        actualDuration: stats.actualDuration,
        avgHeartRate: stats.avgHeartRate,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  console.log(
    `${tag} computedSegments=${computedSegments.length} droppedByStats=${droppedByStats}`,
  );
  return { computedSegments };
}

async function validateSignature(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("validateSignature called without a resolved trainingType");
  }
  const components = mapSegmentsToComponents(state.computedSegments);
  const signature = generateIntervalSignature(components);

  const exact = await db
    .select()
    .from(intervalStructures)
    .where(
      and(
        eq(intervalStructures.signature, signature),
        eq(intervalStructures.trainingType, trainingType),
      ),
    )
    .limit(1);

  if (exact.length > 0) {
    return { signatureCheck: { useExisting: true, structureId: exact[0].id, signature } };
  }

  const signatureParts = signature.split("-").sort();
  const candidates = await db
    .selectDistinct({ id: intervalStructures.id, signature: intervalStructures.signature })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .where(
      and(eq(activities.userId, state.userId), eq(intervalStructures.trainingType, trainingType)),
    );

  let bestId: number | undefined;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (!candidate.signature) continue;
    const candidateParts = candidate.signature.split("-").sort();
    const intersection = signatureParts.filter((p) => candidateParts.includes(p));
    const unionSize = new Set([...signatureParts, ...candidateParts]).size;
    const jaccard = intersection.length / unionSize;
    if (jaccard >= 0.7 && jaccard > bestScore) {
      bestScore = jaccard;
      bestId = candidate.id;
    }
  }

  if (bestId !== undefined) {
    return { signatureCheck: { useExisting: true, structureId: bestId, signature } };
  }

  return { signatureCheck: { useExisting: false, signature } };
}

async function persistResults(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("persistResults called without a resolved trainingType");
  }
  const check = state.signatureCheck;
  if (!check) throw new Error("persistResults called without signatureCheck in state");

  let structureId: number;
  if (check.useExisting && check.structureId !== undefined) {
    structureId = check.structureId;
  } else {
    const components = mapSegmentsToComponents(state.computedSegments);
    const [newStructure] = await db
      .insert(intervalStructures)
      .values({
        name: generateStructureName(components),
        signature: check.signature || null,
        trainingType,
        intervalType: determineIntervalType(state.computedSegments),
      })
      .returning();
    structureId = newStructure.id;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(activities)
      .set({
        intervalStructureId: structureId,
        trainingType,
        analysisStatus: "completed",
        analyzedAt: new Date(),
        notes: state.userNotes,
        draftAnalysisResult: null,
      })
      .where(eq(activities.id, state.activityId));

    await tx.delete(intervalSegments).where(eq(intervalSegments.activityId, state.activityId));

    await tx.insert(intervalSegments).values(state.computedSegments);
  });

  return {};
}

const normalizeKey = (s: string | null | undefined): string => (s ?? "").toLowerCase().trim();

const typeLocKey = (type: EventType, loc: string | null): string => `${type}|${normalizeKey(loc)}`;

function attributeRowsFor(
  eventId: number,
  userId: string,
  atts: EventAttributeOutput[],
): InsertEventAttribute[] {
  const seen = new Set<string>();
  const rows: InsertEventAttribute[] = [];
  for (const a of atts) {
    const key = normalizeKey(a.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      eventId,
      userId,
      key,
      valueType: a.type satisfies AttributeValueType,
      value: a.value,
    });
  }
  return rows;
}

async function detectEvents(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  const title = state.activityTitle;
  const description = state.activityDescription;
  const notes = state.userNotes;
  if (!title && !description && !notes) return {};

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const [alreadyLinked, recent, knownKeys] = await Promise.all([
    db
      .select({
        id: events.id,
        eventType: events.eventType,
        bodyLocation: events.bodyLocation,
        description: events.description,
        lastOccurrence: events.lastOccurrence,
        status: events.status,
      })
      .from(activityEvents)
      .innerJoin(events, eq(events.id, activityEvents.eventId))
      .where(eq(activityEvents.activityId, state.activityId)),
    db
      .select()
      .from(events)
      .where(and(eq(events.userId, state.userId), gte(events.lastOccurrence, oneYearAgo))),
    db
      .selectDistinctOn([eventAttributes.key], {
        key: eventAttributes.key,
        valueType: eventAttributes.valueType,
        sampleValue: eventAttributes.value,
      })
      .from(eventAttributes)
      .where(eq(eventAttributes.userId, state.userId))
      .orderBy(eventAttributes.key, desc(eventAttributes.createdAt)),
  ]);

  const alreadyLinkedIds = new Set(alreadyLinked.map((r) => r.id));
  const alreadyLinkedTypeLoc = new Set(
    alreadyLinked.map((r) => typeLocKey(r.eventType, r.bodyLocation)),
  );
  const recentById = new Map(recent.map((r) => [r.id, r]));

  const knownAttributeKeys: KnownAttributeKey[] = knownKeys.map((k) => ({
    key: k.key,
    valueType: k.valueType,
    sampleValue: JSON.stringify(k.sampleValue),
  }));

  const result = await invokeWithRateLimitRetry(() =>
    invokeEventDetectionAgent(
      title,
      description,
      notes,
      recent.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        bodyLocation: r.bodyLocation,
        description: r.description,
        lastOccurrence: r.lastOccurrence,
        status: r.status,
        alreadyLinkedToThisActivity: alreadyLinkedIds.has(r.id),
      })),
      knownAttributeKeys,
    ),
  );
  if (!result || result.events.length === 0) return {};

  const seen = new Set<string>();
  const deduped = result.events.filter((e) => {
    const key =
      e.linkedEventId !== null
        ? `id:${e.linkedEventId}`
        : `new:${typeLocKey(e.eventType, e.bodyLocation)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const activityStart = state.activityStartDateLocal ?? new Date();

  await db.transaction(async (tx) => {
    for (const e of deduped) {
      let eventId: number;

      if (e.linkedEventId !== null) {
        const existing = recentById.get(e.linkedEventId);
        // LLM hallucinated an id outside the candidate set — skip rather than
        // silently fall through to creating a new event
        if (!existing) continue;
        if (alreadyLinkedIds.has(existing.id)) continue;

        const updates: Partial<InsertEvent> = { updatedAt: new Date() };
        if (activityStart > existing.lastOccurrence) {
          updates.lastOccurrence = activityStart;
        }
        if (e.description && e.description !== existing.description) {
          updates.description = e.description;
        }
        if (e.markResolved && existing.status !== "resolved") {
          updates.status = "resolved";
          updates.resolvedAt = activityStart;
        }
        await tx.update(events).set(updates).where(eq(events.id, existing.id));
        eventId = existing.id;

        const attrRows = attributeRowsFor(eventId, state.userId, e.attributes ?? []);
        if (attrRows.length > 0) {
          await tx
            .insert(eventAttributes)
            .values(attrRows)
            .onConflictDoUpdate({
              target: [eventAttributes.eventId, eventAttributes.key],
              set: {
                valueType: sql`excluded.value_type`,
                value: sql`excluded.value`,
              },
            });
        }
      } else {
        // Final guard: LLM may not realise a new mention matches a condition
        // already linked to this same activity — skip to avoid double-counting
        const key = typeLocKey(e.eventType, e.bodyLocation);
        if (alreadyLinkedTypeLoc.has(key)) continue;

        const [created] = await tx
          .insert(events)
          .values({
            userId: state.userId,
            eventType: e.eventType,
            bodyLocation: e.bodyLocation,
            description: e.description,
            startTime: activityStart,
            lastOccurrence: activityStart,
            status: e.markResolved ? "resolved" : "active",
            resolvedAt: e.markResolved ? activityStart : null,
          })
          .returning({ id: events.id });
        eventId = created.id;
        alreadyLinkedTypeLoc.add(key);

        const attrRows = attributeRowsFor(eventId, state.userId, e.attributes ?? []);
        if (attrRows.length > 0) {
          await tx.insert(eventAttributes).values(attrRows);
        }
      }

      alreadyLinkedIds.add(eventId);

      await tx
        .insert(activityEvents)
        .values({ activityId: state.activityId, eventId })
        .onConflictDoNothing();
    }
  });

  return {};
}

// ── Routing ───────────────────────────────────────────────────────────────────

function routeAfterClassification(state: AnalysisState): "markCompleted" | "awaitUserInput" {
  if (state.canSkipComplete || state.lapsMatchStructure) {
    return "markCompleted";
  }
  return "awaitUserInput";
}

function routeAfterCompleteAnalysis(state: AnalysisState): "validateSignature" | "detectEvents" {
  return state.computedSegments.length > 0 ? "validateSignature" : "detectEvents";
}

let _checkpointerPromise: Promise<PostgresSaver> | null = null;

export function getCheckpointer(): Promise<PostgresSaver> {
  if (!_checkpointerPromise) {
    _checkpointerPromise = (async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not set");
      const pool = new pg.Pool({ connectionString: databaseUrl });
      const cp = new PostgresSaver(pool);
      await cp.setup();
      return cp;
    })().catch((err) => {
      _checkpointerPromise = null;
      throw err;
    });
  }
  return _checkpointerPromise;
}

export async function resetAnalysisThread(activityId: number): Promise<void> {
  const checkpointer = await getCheckpointer();
  await checkpointer.deleteThread(String(activityId));
}

const workflow = new StateGraph(AnalysisStateAnnotation)
  .addNode("classifyActivity", classifyActivity)
  .addNode("markCompleted", markCompleted)
  .addNode("awaitUserInput", awaitUserInput)
  .addNode("runCompleteAnalysis", runCompleteAnalysis)
  .addNode("validateSignature", validateSignature)
  .addNode("persistResults", persistResults)
  .addNode("detectEvents", detectEvents)
  .addEdge(START, "classifyActivity")
  .addConditionalEdges("classifyActivity", routeAfterClassification, [
    "markCompleted",
    "awaitUserInput",
  ])
  .addEdge("markCompleted", END)
  .addEdge("awaitUserInput", "runCompleteAnalysis")
  .addConditionalEdges("runCompleteAnalysis", routeAfterCompleteAnalysis, [
    "validateSignature",
    "detectEvents",
  ])
  .addEdge("validateSignature", "persistResults")
  .addEdge("persistResults", "detectEvents")
  .addEdge("detectEvents", END);

let _compiledGraphPromise: Promise<ReturnType<typeof workflow.compile>> | null = null;

export function buildAnalysisGraph(): Promise<ReturnType<typeof workflow.compile>> {
  if (!_compiledGraphPromise) {
    _compiledGraphPromise = (async () => {
      const checkpointer = await getCheckpointer();
      return workflow.compile({ checkpointer });
    })().catch((err) => {
      _compiledGraphPromise = null;
      throw err;
    });
  }
  return _compiledGraphPromise;
}
