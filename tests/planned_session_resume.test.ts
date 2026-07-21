// Planned-session matching runs AFTER the interrupt, so its state comes back
// from the LangGraph checkpointer through JSON — `activityStartDateLocal` is an
// ISO string, not a Date. A unit test with a hand-built Date state reproduces
// nothing, which is exactly why this shipped broken (30/30 failures in prod).
// This drives the real compiled graph through interrupt + resume.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../src/agent/analysis_graph";
import * as eventAgent from "../src/agent/event_detection_agent";
import * as initialAgent from "../src/agent/initial_analysis_agent";
import type { WorkoutAnalysisOutput } from "../src/agent/initial_analysis_agent";
import * as parseAgent from "../src/agent/parse_intervals_agent";
import { plannedSessions } from "../src/schema";
import * as deterministic from "../src/services/deterministic_segmenter";
import * as paceService from "../src/services/pace_service";
import { resumeAnalysis } from "../src/services/resume_analysis";
import { stravaApiService } from "../src/services/strava_api_service";
import type { StreamSet } from "../src/types/strava/IStream";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";
import {
  insertActivity,
  insertPlannedSession,
  insertTrainingPlan,
  insertTrainingPlanWeek,
} from "./helpers/fixtures";

const TOKEN = "test-strava-token";
const SAMPLES = 1200;
const ACTIVITY_DATE = "2026-02-10";
const ACTIVITY_START_LOCAL = `${ACTIVITY_DATE}T08:00:00Z`;

function buildStreams(): StreamSet {
  return {
    time: { data: Array.from({ length: SAMPLES }, (_, i) => i) },
    distance: { data: Array.from({ length: SAMPLES }, (_, i) => i * 3) },
    velocity_smooth: { data: Array.from({ length: SAMPLES }, () => 3) },
  };
}

describe("matchPlannedSession after a real interrupt + resume", () => {
  let userId: string;
  const spies: { mockRestore: () => void }[] = [];
  const db = () => getDb();

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false });
    userId = user.id;

    spies.push(
      spyOn(stravaApiService, "getActivity").mockResolvedValue({
        id: 1,
        name: "easy shakeout",
        description: null,
        trainer: false,
        start_date_local: ACTIVITY_START_LOCAL,
        type: "Run",
        total_elevation_gain: 0,
      } as never),
      spyOn(stravaApiService, "getActivityStreams").mockResolvedValue(buildStreams() as never),
      spyOn(stravaApiService, "getActivityLaps").mockResolvedValue([] as never),
      spyOn(initialAgent, "invokeActivityAnalysisAgent").mockResolvedValue({
        classification_reasoning: "stub",
        confidence_score: 0.9,
        intervals_description: null,
        training_type: "EASY",
        structure: [],
      } as WorkoutAnalysisOutput as never),
      spyOn(parseAgent, "invokeParseIntervalsAgent").mockResolvedValue({ sets: [] } as never),
      spyOn(paceService, "getProposedPaceForStructure").mockResolvedValue([] as never),
      spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue(null),
      spyOn(eventAgent, "invokeEventDetectionAgent").mockResolvedValue({ events: [] } as never),
    );
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await deleteTestUser(userId);
  });

  async function seedPlannedSession(date: string, sessionType: "EASY" | "LONG_INTERVALS") {
    const plan = await insertTrainingPlan(userId, {
      status: "active",
      startDate: "2026-02-01",
      endDate: "2026-03-01",
    });
    const week = await insertTrainingPlanWeek(plan.id, { startDate: "2026-02-09" });
    return insertPlannedSession(plan.id, week.id, { date, sessionType, status: "planned" });
  }

  async function driveThroughResume(): Promise<number> {
    const seeded = await insertActivity(userId, {
      title: "easy shakeout",
      description: "-",
      analysisStatus: "pending",
      trainingType: null,
      sportType: "Run",
      startDateLocal: new Date(ACTIVITY_START_LOCAL),
    });
    await resetAnalysisThread(seeded.id);
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      { activityId: seeded.id, stravaActivityId: seeded.stravaActivityId, userId },
      {
        configurable: {
          thread_id: String(seeded.id),
          db: db(),
          stravaAccessToken: TOKEN,
          intervalsAthleteId: null,
        },
      },
    );
    await resumeAnalysis(db(), TOKEN, seeded.id, "", [], "EASY", null, []);
    await resetAnalysisThread(seeded.id);
    return seeded.id;
  }

  it("links the matching planned session instead of throwing on the rehydrated date", async () => {
    const session = await seedPlannedSession(ACTIVITY_DATE, "EASY");

    const activityId = await driveThroughResume();

    const [row] = await db()
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, session.id));
    expect(row.completedActivityId).toBe(activityId);
    expect(row.status).toBe("completed");
  });

  it("declines on merit — a far-off session is left planned", async () => {
    const session = await seedPlannedSession("2026-02-20", "EASY");

    await driveThroughResume();

    const [row] = await db()
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, session.id));
    expect(row.completedActivityId).toBeNull();
    expect(row.status).toBe("planned");
  });
});
