import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../src/agent/analysis_graph";
import * as eventAgent from "../src/agent/event_detection_agent";
import * as fullAnalysis from "../src/agent/full_analysis_agent";
import type { SegmentPlanOutput } from "../src/agent/full_analysis_agent";
import * as initialAgent from "../src/agent/initial_analysis_agent";
import type { WorkoutAnalysisOutput } from "../src/agent/initial_analysis_agent";
import * as parseAgent from "../src/agent/parse_intervals_agent";
import { logger } from "../src/logger";
import { updateUserSettings } from "../src/repositories/user_settings_repository";
import { activities, gears } from "../src/schema";
import { intervalSegments } from "../src/schema/interval_segments";
import * as deterministic from "../src/services/deterministic_segmenter";
import * as paceService from "../src/services/pace_service";
import { maybeAutoResumeAnalysis, resumeAnalysis } from "../src/services/resume_analysis";
import { stravaApiService } from "../src/services/strava_api_service";
import { generateCompleteIntervalSet } from "../src/services/utils";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { StreamSet } from "../src/types/strava/IStream";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

// Drives the REAL compiled analysis graph (real PostgresSaver, real nodes) up to
// the interrupt, then exercises the wave-4 auto-resume hook
// (`maybeAutoResumeAnalysis`) directly — startAnalysis itself is a global mock
// no-op, so the hook lives in the un-mocked resume_analysis module. Only the
// external boundaries are stubbed, per the text-authority real-graph recipe.

const SAMPLES = 3000;
const TOKEN = "test-strava-token";

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

// Classifier output keyed on the seeded title, so all scenarios share one spy.
function classify(title: string): WorkoutAnalysisOutput {
  const base = {
    classification_reasoning: "stub",
    confidence_score: 0.9,
    intervals_description: null,
  };
  if (title.startsWith("easy")) {
    return { ...base, training_type: "EASY", structure: [] } as WorkoutAnalysisOutput;
  }
  if (title.startsWith("structureless")) {
    return { ...base, training_type: "LONG_INTERVALS", structure: [] } as WorkoutAnalysisOutput;
  }
  // "10x1000m …" interval titles → a real 10-rep LONG_INTERVALS draft.
  return {
    ...base,
    training_type: "LONG_INTERVALS",
    structure: intervalStructure(10),
  } as WorkoutAnalysisOutput;
}

// Segmentation-LLM stub: WARMUP, then INTERVALS+REST per work step.
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

describe("auto-resume (review-mode bypass) — end-to-end on the real graph", () => {
  let userId: string;
  let shoeId: number;
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

  async function statusOf(activityId: number): Promise<string | undefined> {
    const row = await db().query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { analysisStatus: true },
    });
    return row?.analysisStatus;
  }

  async function setMode(mode: "all" | "intervals_only" | "none"): Promise<void> {
    await updateUserSettings(db(), userId, { analysisReviewMode: mode });
  }

  async function runHook(activityId: number): Promise<void> {
    await maybeAutoResumeAnalysis(db(), TOKEN, activityId, userId, logger);
  }

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false, processHeartRate: false });
    userId = user.id;

    // A shoe + a prior completed Run using it feeds recents-by-type (SHOES/ROAD),
    // so the suggester returns it when an auto-resumed activity has no gear.
    const [gearRow] = await db()
      .insert(gears)
      .values({ userId, model: "Recent Shoe", gearType: "SHOES", surface: "ROAD" })
      .returning({ id: gears.id });
    shoeId = gearRow.id;
    await insertActivity(userId, {
      sportType: "Run",
      localGearId: shoeId,
      analysisStatus: "completed",
      trainingType: "EASY",
    });

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
        async (_streams: unknown, title: string) => classify(title) as never,
      ),
      spyOn(parseAgent, "invokeParseIntervalsAgent").mockImplementation(
        async (text: string) =>
          (/\d\s*[x×]\s*1000|1000\s*m/i.test(text)
            ? { sets: intervalStructure(10) }
            : { sets: [] }) as never,
      ),
      spyOn(paceService, "getProposedPaceForStructure").mockImplementation(
        async (_db: unknown, _uid: unknown, structure: never) =>
          generateCompleteIntervalSet(structure) as never,
      ),
      spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue(null),
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
      spyOn(eventAgent, "invokeEventDetectionAgent").mockResolvedValue({ events: [] } as never),
    );
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await deleteTestUser(userId);
  });

  it("intervals_only: an EASY activity auto-completes with the suggested gear", async () => {
    await setMode("intervals_only");
    const { id, strava } = await seedActivity("easy morning jog");
    await driveToInitial(id, strava);
    expect(await statusOf(id)).toBe("initial");

    await runHook(id);

    const row = await db().query.activities.findFirst({
      where: eq(activities.id, id),
      columns: { analysisStatus: true, localGearId: true },
    });
    expect(row?.analysisStatus).toBe("completed");
    expect(row?.localGearId).toBe(shoeId);

    const segs = await db()
      .select()
      .from(intervalSegments)
      .where(eq(intervalSegments.activityId, id));
    for (const s of segs) expect(s.targetPace).toBeNull();

    await resetAnalysisThread(id);
  });

  it("intervals_only: a LONG_INTERVALS activity stays paused at initial", async () => {
    await setMode("intervals_only");
    const { id, strava } = await seedActivity("10x1000m io");
    await driveToInitial(id, strava);
    expect(await statusOf(id)).toBe("initial");

    await runHook(id);

    expect(await statusOf(id)).toBe("initial");
    const segs = await db()
      .select()
      .from(intervalSegments)
      .where(eq(intervalSegments.activityId, id));
    expect(segs).toHaveLength(0);

    await resetAnalysisThread(id);
  });

  it("none: an interval activity auto-completes with all-null target paces and persisted segments", async () => {
    await setMode("none");
    const { id, strava } = await seedActivity("10x1000m none");
    await driveToInitial(id, strava);
    expect(await statusOf(id)).toBe("initial");

    await runHook(id);

    expect(await statusOf(id)).toBe("completed");
    const segs = await db()
      .select()
      .from(intervalSegments)
      .where(eq(intervalSegments.activityId, id));
    const intervalsRows = segs.filter((s) => s.type === "INTERVALS");
    expect(intervalsRows).toHaveLength(10);
    for (const s of segs) expect(s.targetPace).toBeNull();

    await resetAnalysisThread(id);
  });

  it("none: a structureless interval draft falls back to manual review (initial, not error)", async () => {
    await setMode("none");
    const { id, strava } = await seedActivity("structureless intervals");
    await driveToInitial(id, strava);
    expect(await statusOf(id)).toBe("initial");

    await runHook(id); // resumeAnalysis throws ResumeValidationError → swallowed

    expect(await statusOf(id)).toBe("initial");

    await resetAnalysisThread(id);
  });

  it("user-wins race: a resume that finds no pending interrupt is a no-op success (no error)", async () => {
    await setMode("none");
    const { id, strava } = await seedActivity("easy user wins");
    await driveToInitial(id, strava);

    // The user's own resume lands first and completes the thread.
    await resumeAnalysis(db(), TOKEN, id, "", [], null, null, []);
    expect(await statusOf(id)).toBe("completed");

    // Simulate the narrow race window: the row reads `initial` again while the
    // graph thread's interrupt is already consumed.
    await db()
      .update(activities)
      .set({ analysisStatus: "initial" })
      .where(eq(activities.id, id));

    await runHook(id); // resumeAnalysis → NoPendingInterruptError → treated as success

    // No error status, no throw: the auto path lost the race gracefully.
    expect(await statusOf(id)).not.toBe("error");

    await resetAnalysisThread(id);
  });

  it("all (default): the activity pauses at initial, no auto-resume", async () => {
    await setMode("all");
    const { id, strava } = await seedActivity("10x1000m all");
    await driveToInitial(id, strava);
    expect(await statusOf(id)).toBe("initial");

    await runHook(id);

    expect(await statusOf(id)).toBe("initial");
    const segs = await db()
      .select()
      .from(intervalSegments)
      .where(eq(intervalSegments.activityId, id));
    expect(segs).toHaveLength(0);

    await resetAnalysisThread(id);
  });
});
