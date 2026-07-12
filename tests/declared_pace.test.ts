import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../src/agent/analysis_graph";
import * as eventAgent from "../src/agent/event_detection_agent";
import * as fullAnalysis from "../src/agent/full_analysis_agent";
import type { SegmentPlanOutput } from "../src/agent/full_analysis_agent";
import * as initialAgent from "../src/agent/initial_analysis_agent";
import type { WorkoutAnalysisOutput } from "../src/agent/initial_analysis_agent";
import * as parseAgent from "../src/agent/parse_intervals_agent";
import type { ParseWorkoutSet } from "../src/agent/parse_intervals_agent";
import { logger } from "../src/logger";
import { updateUserSettings } from "../src/repositories/user_settings_repository";
import { activities } from "../src/schema";
import { intervalSegments } from "../src/schema/interval_segments";
import { getEditorState } from "../src/services/editor_state_service";
import * as deterministic from "../src/services/deterministic_segmenter";
import * as paceService from "../src/services/pace_service";
import { maybeAutoResumeAnalysis } from "../src/services/resume_analysis";
import { stravaApiService } from "../src/services/strava_api_service";
import { expandDeclaredPaces } from "../src/services/text_intent_service";
import { generateCompleteIntervalSet, parsePaceStringToMetersPerSecond } from "../src/services/utils";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { StreamSet } from "../src/types/strava/IStream";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

// D6 (declared-pace extraction) on the REAL analysis graph, mirroring the
// text-authority real-graph recipe from tests/auto_resume.test.ts. Only the
// external boundaries (strava, the two LLM agents, pace history) are stubbed.

const SAMPLES = 3000;
const TOKEN = "test-strava-token";
const PACE_3_45 = parsePaceStringToMetersPerSecond("3:45"); // ≈ 4.444 m/s

function buildStreams(): StreamSet {
  const time = Array.from({ length: SAMPLES }, (_, i) => i);
  const distance = Array.from({ length: SAMPLES }, (_, i) => i * 3);
  const velocity = Array.from({ length: SAMPLES }, () => 3);
  return {
    time: { data: time },
    distance: { data: distance },
    velocity_smooth: { data: velocity },
  };
}

// One set, one step of `reps` × 1000m — the classifier's draft structure.
const intervalStructure = (reps: number) => [
  {
    set_reps: 1,
    set_recovery: 300,
    steps: [
      {
        reps,
        work_type: "DISTANCE" as const,
        work_value: 1000,
        recovery_type: "TIME" as const,
        recovery_value: 90,
      },
    ],
  },
];

// The parse agent's paced output for "10x1000m …": optionally carries an explicit
// per-step target_pace_string exactly as the LLM would extract it from the text.
const pacedStructure = (pace: string | null): ParseWorkoutSet[] => [
  {
    set_reps: 1,
    set_recovery: 300,
    steps: [
      {
        reps: 10,
        work_type: "DISTANCE",
        work_value: 1000,
        recovery_type: "TIME",
        recovery_value: 90,
        target_pace_string: pace,
      },
    ],
  },
];

// Every seeded title classifies as a real 10-rep LONG_INTERVALS draft; the text
// gate is what decides whether a declared pace comes through.
function classify(): WorkoutAnalysisOutput {
  return {
    classification_reasoning: "stub",
    confidence_score: 0.9,
    intervals_description: null,
    training_type: "LONG_INTERVALS",
    structure: intervalStructure(10),
  } as WorkoutAnalysisOutput;
}

function buildPlanFromGroups(groups: ExpandedIntervalSet[]): SegmentPlanOutput {
  const segments: SegmentPlanOutput["segments"] = [];
  let t = 0;
  segments.push({
    type: "WARMUP",
    start_time: t,
    end_time: t + 200,
    target_type: "custom",
    target_value: 0,
  });
  t += 200;
  let groupIndex = 0;
  for (const group of groups) {
    groupIndex += 1;
    for (const step of group.steps) {
      segments.push({
        type: "INTERVALS",
        start_time: t,
        end_time: t + 100,
        set_group_index: groupIndex,
        target_type: step.work_type === "DISTANCE" ? "distance" : "time",
        target_value: step.work_value,
      });
      t += 100;
      segments.push({
        type: "REST",
        start_time: t,
        end_time: t + 60,
        set_group_index: groupIndex,
        target_type: "time",
        target_value: 60,
      });
      t += 60;
    }
  }
  return { segments };
}

describe("declared-pace extraction (D6) — end-to-end on the real graph", () => {
  let userId: string;
  const spies: { mockRestore: () => void }[] = [];

  const db = () => getDb();

  async function seedActivity(title: string): Promise<{ id: number; strava: number }> {
    const seeded = await insertActivity(userId, {
      title,
      description: "-",
      analysisStatus: "pending",
      trainingType: null,
      indoor: false,
      localGearId: null,
      sportType: "Run",
    });
    return { id: seeded.id, strava: seeded.stravaActivityId };
  }

  async function driveToInitial(activityId: number, strava: number): Promise<void> {
    await resetAnalysisThread(activityId);
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      { activityId, stravaActivityId: strava, userId },
      {
        configurable: {
          thread_id: String(activityId),
          db: db(),
          stravaAccessToken: TOKEN,
          intervalsAthleteId: null,
        },
      },
    );
  }

  async function draftStructureOf(activityId: number) {
    const row = await db().query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { draftAnalysisResult: true },
    });
    return row?.draftAnalysisResult?.structure ?? [];
  }

  async function segmentsOf(activityId: number) {
    return db().select().from(intervalSegments).where(eq(intervalSegments.activityId, activityId));
  }

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false, processHeartRate: false });
    userId = user.id;
    await updateUserSettings(db(), userId, { analysisReviewMode: "none" });

    const streams = buildStreams();
    spies.push(
      spyOn(stravaApiService, "getActivity").mockResolvedValue({
        id: 1,
        name: "auto-name",
        description: null,
        trainer: false,
        start_date_local: new Date().toISOString(),
        type: "Run",
        total_elevation_gain: 0,
      } as never),
      spyOn(stravaApiService, "getActivityStreams").mockResolvedValue(streams as never),
      spyOn(stravaApiService, "getActivityLaps").mockResolvedValue([] as never),
      spyOn(initialAgent, "invokeActivityAnalysisAgent").mockImplementation(
        async () => classify() as never,
      ),
      // Parse the text: a title mentioning 1000m yields a 10x1000m structure; when
      // it ALSO states "3:45" the step carries that as target_pace_string. Generic
      // titles never reach here (the deterministic prefilter blocks them).
      spyOn(parseAgent, "invokeParseIntervalsAgent").mockImplementation(async (text: string) => {
        if (!/1000/.test(text)) return { sets: [] } as never;
        const pace = /3:45/.test(text) ? "3:45" : null;
        return { sets: pacedStructure(pace) } as never;
      }),
      spyOn(paceService, "getProposedPaceForStructure").mockImplementation(
        async (_db: unknown, _uid: unknown, structure: never) =>
          generateCompleteIntervalSet(structure) as never,
      ),
      spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue(null),
      spyOn(eventAgent, "invokeEventDetectionAgent").mockResolvedValue({ events: [] } as never),
      spyOn(fullAnalysis, "invokeCompleteActivityAnalysisAgent").mockImplementation(
        async (
          _streams: unknown,
          _comment: unknown,
          _tt: unknown,
          _laps: unknown,
          _init: unknown,
          groups: ExpandedIntervalSet[],
        ) => buildPlanFromGroups(groups) as never,
      ),
    );
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await deleteTestUser(userId);
  });

  it("a: '10x1000m @ 3:45' auto-completes with the declared pace on every work step", async () => {
    const { id, strava } = await seedActivity("10x1000m @ 3:45");
    await driveToInitial(id, strava);
    expect(await draftStructureOf(id)).toHaveLength(1);

    await maybeAutoResumeAnalysis(db(), TOKEN, id, userId, logger);

    expect(
      (
        await db().query.activities.findFirst({
          where: eq(activities.id, id),
          columns: { analysisStatus: true },
        })
      )?.analysisStatus,
    ).toBe("completed");

    const segs = await segmentsOf(id);
    const work = segs.filter((s) => s.type === "INTERVALS");
    const rest = segs.filter((s) => s.type === "REST");
    expect(work).toHaveLength(10);
    for (const s of work) expect(s.targetPace).toBeCloseTo(PACE_3_45 as number, 3);
    for (const s of rest) expect(s.targetPace).toBeNull();

    await resetAnalysisThread(id);
  });

  it("b: /editor-state proposal shows the declared pace, overriding lap/history", async () => {
    const { id, strava } = await seedActivity("10x1000m @ 3:45 editor");
    await driveToInitial(id, strava);

    const structure = await draftStructureOf(id);
    const { sets } = await getEditorState(
      db(),
      userId,
      TOKEN,
      id,
      { structure, trainingType: "LONG_INTERVALS", includeStreams: false },
      logger,
    );

    const paces = sets.flatMap((s) => s.steps.map((st) => st.target_pace));
    expect(paces).toHaveLength(10);
    for (const p of paces) expect(p).toBeCloseTo(PACE_3_45 as number, 3);

    await resetAnalysisThread(id);
  });

  it("c: '10x1000m' with no stated pace auto-completes with all target paces null", async () => {
    const { id, strava } = await seedActivity("10x1000m");
    await driveToInitial(id, strava);

    await maybeAutoResumeAnalysis(db(), TOKEN, id, userId, logger);

    const segs = await segmentsOf(id);
    expect(segs.filter((s) => s.type === "INTERVALS")).toHaveLength(10);
    for (const s of segs) expect(s.targetPace).toBeNull();

    // The editor proposal is likewise unpaced (history mock returns null paces).
    const structure = await draftStructureOf(id);
    const { sets } = await getEditorState(
      db(),
      userId,
      TOKEN,
      id,
      { structure, trainingType: "LONG_INTERVALS", includeStreams: false },
      logger,
    );
    for (const st of sets.flatMap((s) => s.steps)) expect(st.target_pace).toBeNull();

    await resetAnalysisThread(id);
  });

  it("e: a model-derived structure never applies a declared pace", async () => {
    // Generic title → fails the prefilter → structureSource stays 'model', the
    // parse agent (and any hallucinated pace) never runs.
    const { id, strava } = await seedActivity("steady model run");
    await driveToInitial(id, strava);

    const draft = await db().query.activities.findFirst({
      where: eq(activities.id, id),
      columns: { draftAnalysisResult: true },
    });
    expect(draft?.draftAnalysisResult?.structureSource).toBe("model");
    expect(draft?.draftAnalysisResult?.declaredPaces ?? null).toBeNull();

    await maybeAutoResumeAnalysis(db(), TOKEN, id, userId, logger);

    const segs = await segmentsOf(id);
    expect(segs.filter((s) => s.type === "INTERVALS")).toHaveLength(10);
    for (const s of segs) expect(s.targetPace).toBeNull();

    await resetAnalysisThread(id);
  });
});

describe("expandDeclaredPaces — pace-string variants (D6)", () => {
  const one = (pace: string | null) => expandDeclaredPaces(pacedStructure(pace))[0];

  it("d: parses /km, @, and 'min/km' forms; garbage → null", () => {
    expect(one("3:45")).toBeCloseTo(PACE_3_45 as number, 3);
    expect(one("3:45/km")).toBeCloseTo(PACE_3_45 as number, 3);
    expect(one("@ 3:45")).toBeCloseTo(PACE_3_45 as number, 3);
    expect(one("4:10 min/km")).toBeCloseTo(4.0, 3); // 4:10/km = 250 s/km = 4.0 m/s
    expect(one(null)).toBeNull();
    expect(one("fast")).toBeNull();
    expect(one("easy pace")).toBeNull();
  });

  it("d: expands one pace entry per work rep, positionally", () => {
    const paces = expandDeclaredPaces(pacedStructure("3:45"));
    expect(paces).toHaveLength(10);
    for (const p of paces) expect(p).toBeCloseTo(PACE_3_45 as number, 3);
  });
});
