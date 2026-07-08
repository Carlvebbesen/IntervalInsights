// End-to-end ride + ski coverage for the multisport rollout (D6/D7): a webhook
// for a Ride / NordicSki passes the widened ingest gate, imports as pending, and
// shows up in /pending with the right gear-type suggestion (bike / skis). Plus a
// direct check that the sport-aware classifier prompt differs for power sports.

import type { ChatOpenAI } from "@langchain/openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { invokeActivityAnalysisAgent } from "../src/agent/initial_analysis_agent";
import { activities, gears, users } from "../src/schema";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

// Real webhook processor (setup.ts mocks the module globally for endpoint tests).
const { processStravaWebhook } = (await import(
  "../src/services/process_strava_event.ts?real=1"
)) as typeof import("../src/services/process_strava_event");

const db = getDb();
const app = buildTestApp(getPool());

let stravaIdSeq = 810_000 + Math.floor(Math.random() * 100_000);
const nextId = () => ++stravaIdSeq;

function stravaActivity(id: number, athleteId: number, sportType: string) {
  return {
    id,
    athlete: { id: athleteId },
    name: `Webhook ${sportType}`,
    description: "",
    sport_type: sportType,
    type: sportType,
    distance: 20000,
    moving_time: 3600,
    total_elevation_gain: 100,
    start_date_local: "2026-07-01T10:00:00Z",
    has_heartrate: false,
    gear_id: null,
    trainer: false,
    splits_metric: [],
  };
}

function createEvent(objectId: number, ownerId: number) {
  return {
    object_type: "activity" as const,
    object_id: objectId,
    aspect_type: "create" as const,
    owner_id: ownerId,
    subscription_id: 999,
    event_time: Math.floor(Date.now() / 1000),
    updates: {},
  };
}

async function createStravaUser() {
  const user = await createTestUser({ role: "premium" });
  const athleteId = nextId();
  await db.update(users).set({ stravaId: String(athleteId) }).where(eq(users.id, user.id));
  return { ...user, athleteId };
}

const realGetActivity = stravaApiService.getActivity;
let getActivityResult: unknown;
beforeEach(() => {
  stravaApiService.getActivity = (async () =>
    getActivityResult) as typeof stravaApiService.getActivity;
});
afterEach(() => {
  stravaApiService.getActivity = realGetActivity;
});
afterAll(async () => {
  await closePool();
});

type PendingRow = { id: number; suggestedGearId: number | null; gearSuggestions: number[] };

async function fetchPending(user: { id: string; clerkId: string }): Promise<Map<number, PendingRow>> {
  return withIdentity(
    { userId: user.id, clerkUserId: user.clerkId, role: "premium" },
    async () => {
      const res = await app.fetch(new Request("http://test/api/v1/agents/pending"));
      expect(res.status).toBe(200);
      const body: PendingRow[] = await res.json();
      return new Map(body.map((r) => [r.id, r]));
    },
  );
}

describe("multisport webhook → pending → gear suggestion", () => {
  it("imports a Ride webhook as pending and suggests a BICYCLE gear", async () => {
    const user = await createStravaUser();
    try {
      const rideStravaId = nextId() * 1000;
      getActivityResult = stravaActivity(rideStravaId, user.athleteId, "Ride");
      await processStravaWebhook(createEvent(rideStravaId, user.athleteId), { db });

      const [ride] = await db
        .select()
        .from(activities)
        .where(eq(activities.stravaActivityId, rideStravaId));
      expect(ride).toBeDefined();
      expect(ride.sportType).toBe("Ride");
      expect(ride.analysisStatus).toBe("pending");

      // Seed a bike + a prior ride on it so recents-by-type has a candidate.
      const [bike] = await db
        .insert(gears)
        .values({ userId: user.id, model: "Bike One", gearType: "BICYCLE", surface: "ROAD" })
        .returning();
      const [shoe] = await db
        .insert(gears)
        .values({ userId: user.id, model: "Shoe One", gearType: "SHOES", surface: "ROAD" })
        .returning();
      await insertActivity(user.id, {
        sportType: "Ride",
        localGearId: bike.id,
        analysisStatus: "completed",
        trainingType: "EASY",
      });

      const pending = await fetchPending(user);
      const row = pending.get(ride.id);
      expect(row?.suggestedGearId).toBe(bike.id);
      expect(row?.gearSuggestions).not.toContain(shoe.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("imports a NordicSki webhook as pending and suggests a SKIS gear", async () => {
    const user = await createStravaUser();
    try {
      const skiStravaId = nextId() * 1000;
      getActivityResult = stravaActivity(skiStravaId, user.athleteId, "NordicSki");
      await processStravaWebhook(createEvent(skiStravaId, user.athleteId), { db });

      const [ski] = await db
        .select()
        .from(activities)
        .where(eq(activities.stravaActivityId, skiStravaId));
      expect(ski).toBeDefined();
      expect(ski.sportType).toBe("NordicSki");
      expect(ski.analysisStatus).toBe("pending");

      const [skis] = await db
        .insert(gears)
        .values({ userId: user.id, model: "Fischer Classic", gearType: "SKIS", surface: "CLASSIC" })
        .returning();
      const [bike] = await db
        .insert(gears)
        .values({ userId: user.id, model: "Bike Two", gearType: "BICYCLE", surface: "ROAD" })
        .returning();
      await insertActivity(user.id, {
        sportType: "NordicSki",
        localGearId: skis.id,
        analysisStatus: "completed",
        trainingType: "EASY",
      });

      const pending = await fetchPending(user);
      const row = pending.get(ski.id);
      expect(row?.suggestedGearId).toBe(skis.id);
      expect(row?.gearSuggestions).not.toContain(bike.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("imports a Hike webhook as pending and still suggests a SHOES gear", async () => {
    const user = await createStravaUser();
    try {
      const hikeStravaId = nextId() * 1000;
      getActivityResult = stravaActivity(hikeStravaId, user.athleteId, "Hike");
      await processStravaWebhook(createEvent(hikeStravaId, user.athleteId), { db });

      const [hike] = await db
        .select()
        .from(activities)
        .where(eq(activities.stravaActivityId, hikeStravaId));
      expect(hike).toBeDefined();
      expect(hike.sportType).toBe("Hike");
      expect(hike.analysisStatus).toBe("pending");

      const [shoe] = await db
        .insert(gears)
        .values({ userId: user.id, model: "Trail Shoe", gearType: "SHOES", surface: "TRAIL" })
        .returning();
      await insertActivity(user.id, {
        sportType: "Hike",
        localGearId: shoe.id,
        analysisStatus: "completed",
        trainingType: "EASY",
      });

      const pending = await fetchPending(user);
      const row = pending.get(hike.id);
      expect(row?.suggestedGearId).toBe(shoe.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("sport-aware classifier prompt (D7)", () => {
  // Fake model: capture the prompt invokeStructured builds, return a canned
  // classification so the pipeline stays in the existing taxonomy without OpenAI.
  function capturingModel(): { model: ChatOpenAI; prompts: string[] } {
    const prompts: string[] = [];
    const model = {
      withStructuredOutput: () => ({
        invoke: async (prompt: string) => {
          prompts.push(prompt);
          return {
            classification_reasoning: "steady effort, no structured reps",
            training_type: "EASY" as const,
            confidence_score: 0.9,
          };
        },
      }),
    } as unknown as ChatOpenAI;
    return { model, prompts };
  }

  const streams = {
    time: { data: [0, 30, 60, 90], original_size: 4, resolution: "high", series_type: "time" },
    distance: {
      data: [0, 100, 200, 300],
      original_size: 4,
      resolution: "high",
      series_type: "distance",
    },
    velocity_smooth: {
      data: [3, 3, 3, 3],
      original_size: 4,
      resolution: "high",
      series_type: "distance",
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stream fixture
  } as any;

  it("adds power-sport framing for a Ride and still classifies into the taxonomy", async () => {
    const { model, prompts } = capturingModel();
    const out = await invokeActivityAnalysisAgent(
      streams,
      "Endurance ride",
      "-",
      100,
      "Ride",
      null,
      [],
      model,
    );
    expect(out?.training_type).toBe("EASY");
    expect(prompts[0]).toContain("SPORT CONTEXT");
    expect(prompts[0]).toContain("NOT a run");
    expect(prompts[0]).toContain("endurance coach");
  });

  it("adds power-sport framing for a NordicSki", async () => {
    const { model, prompts } = capturingModel();
    await invokeActivityAnalysisAgent(streams, "Classic ski", "-", 100, "NordicSki", null, [], model);
    expect(prompts[0]).toContain("SPORT CONTEXT");
    expect(prompts[0]).toContain("NordicSki");
  });

  it("keeps the run prompt pace-based with no sport-context block", async () => {
    const { model, prompts } = capturingModel();
    await invokeActivityAnalysisAgent(streams, "Morning run", "-", 20, "Run", null, [], model);
    expect(prompts[0]).not.toContain("SPORT CONTEXT");
    expect(prompts[0]).toContain("running coach");
  });
});
