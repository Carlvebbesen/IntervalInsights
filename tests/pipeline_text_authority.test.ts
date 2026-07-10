import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Command } from "@langchain/langgraph";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../src/agent/analysis_graph";
import * as eventAgent from "../src/agent/event_detection_agent";
import * as fullAnalysis from "../src/agent/full_analysis_agent";
import type { SegmentPlanOutput } from "../src/agent/full_analysis_agent";
import * as initialAgent from "../src/agent/initial_analysis_agent";
import type { WorkoutAnalysisOutput } from "../src/agent/initial_analysis_agent";
import * as parseAgent from "../src/agent/parse_intervals_agent";
import { activities } from "../src/schema";
import { intervalSegments } from "../src/schema/interval_segments";
import type { DraftAnalysisResult } from "../src/schema/activities";
import * as deterministic from "../src/services/deterministic_segmenter";
import * as paceService from "../src/services/pace_service";
import { stravaApiService } from "../src/services/strava_api_service";
import { generateCompleteIntervalSet } from "../src/services/utils";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { StreamSet } from "../src/types/strava/IStream";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

// End-to-end drive of the REAL compiled analysis graph (real PostgresSaver
// checkpointer, real nodes, real reconciliation + declaredReps enforcement).
// Only the external boundaries are stubbed: the classifier LLM (deliberately
// WRONG — EASY / 8 reps), the parse agent (text → sets), the segmentation LLM
// (builds a plan straight from its userSets so the work count follows the
// authoritative shape), the event agent (no events), the deterministic
// segmenter (forced off so the LLM rung is always reached), the pace fill, and
// the Strava fetch. The scenario is the flagship failure mode this project
// fixes: a colloquial "10x1000m" title the classifier collapses to EASY.

const SAMPLES = 3000; // 1s samples over ~50 min

function buildStreams(): StreamSet {
  const time = Array.from({ length: SAMPLES }, (_, i) => i);
  const distance = Array.from({ length: SAMPLES }, (_, i) => i * 3); // ~3 m/s
  const velocity = Array.from({ length: SAMPLES }, () => 3);
  return {
    time: { data: time },
    distance: { data: distance },
    velocity_smooth: { data: velocity },
  };
}

const declaredSet = (reps: number) => ({
  set_reps: 1,
  set_recovery: 0,
  steps: [
    {
      reps,
      work_type: "DISTANCE" as const,
      work_value: 1000,
      recovery_type: null,
      recovery_value: 0,
    },
  ],
});

// The segmentation-LLM stub: WARMUP, then per work step an INTERVALS + REST,
// with plausible times inside the stream range. Work count == total steps.
function buildPlanFromGroups(groups: ExpandedIntervalSet[]): SegmentPlanOutput {
  const segments: SegmentPlanOutput["segments"] = [];
  let t = 0;
  segments.push({ type: "WARMUP", start_time: t, end_time: t + 200, target_type: "custom", target_value: 0 });
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

function totalReps(structure: WorkoutAnalysisOutput["structure"]): number {
  return (structure ?? []).reduce(
    (n, s) => n + (s.set_reps ?? 1) * s.steps.reduce((a, st) => a + (st.reps ?? 1), 0),
    0,
  );
}

describe("analysis graph — text as structure authority (end-to-end)", () => {
  let userId: string;
  let activityId: number;
  let stravaActivityId: number;

  const spies: { mockRestore: () => void }[] = [];

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false, processHeartRate: false });
    userId = user.id;
    const seeded = await insertActivity(userId, {
      title: "10x1000m",
      description: "-",
      analysisStatus: "pending",
      trainingType: null,
      indoor: false,
    });
    activityId = seeded.id;
    stravaActivityId = seeded.stravaActivityId;

    const streams = buildStreams();

    // ─── Strava boundary ────────────────────────────────────────────────────
    spies.push(
      spyOn(stravaApiService, "getActivity").mockResolvedValue({
        id: stravaActivityId,
        name: "auto-name",
        description: null,
        trainer: false,
        start_date_local: new Date().toISOString(),
        type: "Run",
        total_elevation_gain: 0,
      } as never),
      spyOn(stravaApiService, "getActivityStreams").mockResolvedValue(streams as never),
      spyOn(stravaApiService, "getActivityLaps").mockResolvedValue([] as never),
    );

    // ─── Classifier LLM (deliberately WRONG: EASY, 8×1000m) ─────────────────
    spies.push(
      spyOn(initialAgent, "invokeActivityAnalysisAgent").mockResolvedValue({
        classification_reasoning: "stub",
        training_type: "EASY",
        confidence_score: 0.9,
        intervals_description: null,
        structure: [
          {
            set_reps: 1,
            set_recovery: 300,
            steps: [
              {
                reps: 8,
                work_type: "DISTANCE",
                work_value: 1000,
                recovery_type: "TIME",
                recovery_value: 90,
              },
            ],
          },
        ],
      } as never),
    );

    // ─── Parse agent: title-like → 10; "8 av 10" notes name no distances, so the
    // real agent returns empty (the 8 is carried by applyPartialCompletion) ─────
    spies.push(
      spyOn(parseAgent, "invokeParseIntervalsAgent").mockImplementation(async (text: string) => {
        if (/\d\s*[x×]\s*1000|1000\s*m/i.test(text)) return { sets: [declaredSet(10)] };
        return { sets: [] };
      }),
    );

    // ─── Pace fill: keep the full expanded structure (setup stub returns []) ──
    spies.push(
      spyOn(paceService, "getProposedPaceForStructure").mockImplementation(
        async (_db: unknown, _uid: unknown, structure: never) =>
          generateCompleteIntervalSet(structure) as never,
      ),
    );

    // ─── Deterministic segmenter off → LLM rung always reached ──────────────
    spies.push(spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue(null));

    // ─── Segmentation LLM builds a plan straight from its userSets shape ─────
    spies.push(
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

    // ─── Event detection: no events ─────────────────────────────────────────
    spies.push(
      spyOn(eventAgent, "invokeEventDetectionAgent").mockResolvedValue({ events: [] } as never),
    );

    await resetAnalysisThread(activityId);
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await resetAnalysisThread(activityId).catch(() => {});
    // Cascades activity + interval_segments rows. The global interval_structures
    // dedupe row is intentionally left (shared/ephemeral in the disposable DB).
    await deleteTestUser(userId);
  });

  const config = () => ({
    configurable: {
      thread_id: String(activityId),
      db: getDb(),
      stravaAccessToken: "test-strava-token",
      intervalsAthleteId: null,
    },
  });

  it("start → interrupt: text overrides EASY, structure is 10 reps of LONG_INTERVALS", async () => {
    const graph = await buildAnalysisGraph();
    await graph.invoke({ activityId, stravaActivityId, userId }, config());

    const db = getDb();
    const row = await db.query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { analysisStatus: true, draftAnalysisResult: true },
    });
    expect(row).toBeTruthy();
    expect(row?.analysisStatus).toBe("initial");

    const draft = row?.draftAnalysisResult as DraftAnalysisResult;
    expect(draft.structureSource).toBe("text");
    expect(draft.declaredStructure).toBeTruthy();
    expect(draft.training_type).toBe("LONG_INTERVALS");
    expect(totalReps(draft.structure)).toBe(10);

    const proposedIntervals = (draft.proposedSegments ?? []).filter((s) => s.type === "INTERVALS");
    expect(proposedIntervals).toHaveLength(10);
  });

  it("resume with notes '8 av 10': completes with exactly 8 INTERVALS segments", async () => {
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      new Command({
        resume: {
          notes: "klarte bare 8 av 10",
          sets: [],
          trainingType: null,
          feeling: 3,
          editedSegments: [],
        },
      }),
      config(),
    );

    const db = getDb();
    const row = await db.query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { analysisStatus: true, intervalStructureId: true },
    });
    expect(row?.analysisStatus).toBe("completed");
    expect(row?.intervalStructureId).toBeTruthy();

    const segs = await db
      .select()
      .from(intervalSegments)
      .where(eq(intervalSegments.activityId, activityId));
    const intervalsRows = segs.filter((s) => s.type === "INTERVALS");
    expect(intervalsRows).toHaveLength(8);
  });
});
