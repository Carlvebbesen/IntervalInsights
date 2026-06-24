import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, intervalSegments } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

let streamsResult: {
  time?: { data: number[] };
  distance?: { data: number[] };
  heartrate?: { data: number[] };
  velocity_smooth?: { data: number[] };
} = {};

mock.module("../src/services/strava_api_service.ts", () => ({
  stravaApiService: {
    getActivity: async () => ({ id: 1, splits_metric: [] }),
    getGear: async (_t: string, id: string) => ({
      id,
      name: `Mock Gear ${id}`,
      distance: 0,
      retired: false,
    }),
    getActivityStreams: async () => streamsResult,
    getActivityLaps: async () => [],
    listAthleteActivities: async () => [],
    syncStravaActivities: async (_t: string, _u: string, ids: number[]) =>
      ids.map((id) => ({ id, status: "success" as const })),
  },
}));

const app = buildTestApp(getPool());

function fullStreams() {
  return {
    time: { data: [0, 10, 20, 30, 40, 50, 60] },
    distance: { data: [0, 30, 60, 90, 120, 150, 180] },
    heartrate: { data: [100, 110, 120, 130, 140, 150, 160] },
    velocity_smooth: { data: [3, 3, 3, 3, 3, 3, 3] },
  };
}

let user: { id: string; clerkId: string };
let noConsentUser: { id: string; clerkId: string };
let draftActivityId: number;
let noConsentDraftActivityId: number;
let putActivityId: number;
let patchActivityId: number;
let warmupSegId: number;
let intervalSegId: number;

const proposedSegments = [
  {
    segmentIndex: 0,
    setGroupIndex: 0,
    type: "WARMUP",
    timeSeriesEndTime: 20,
    actualDistance: 60,
    actualDuration: 20,
    avgHeartRate: 110,
    targetType: "custom",
    targetValue: 0,
    targetPace: null,
  },
  {
    segmentIndex: 1,
    setGroupIndex: 1,
    type: "INTERVALS",
    timeSeriesEndTime: 60,
    actualDistance: 120,
    actualDuration: 40,
    avgHeartRate: 140,
    targetType: "distance",
    targetValue: 1000,
    targetPace: 3.2,
  },
] as const;

async function seedDraft(activityId: number) {
  await getDb()
    .update(activities)
    .set({
      analysisStatus: "initial",
      draftAnalysisResult: {
        classification_reasoning: "1000m reps; 1000 >= 800 -> LONG_INTERVALS",
        training_type: "LONG_INTERVALS",
        confidence_score: 0.9,
        proposedSegments: [...proposedSegments],
      },
    })
    .where(eq(activities.id, activityId));
}

beforeAll(async () => {
  user = await createTestUser({ role: "premium", processHeartRate: true });
  noConsentUser = await createTestUser({ role: "premium", processHeartRate: false });

  draftActivityId = (
    await insertActivity(user.id, { trainingType: "LONG_INTERVALS", title: "Draft" })
  ).id;
  await seedDraft(draftActivityId);

  noConsentDraftActivityId = (
    await insertActivity(noConsentUser.id, { trainingType: "LONG_INTERVALS", title: "DraftNC" })
  ).id;
  await seedDraft(noConsentDraftActivityId);

  putActivityId = (
    await insertActivity(user.id, { trainingType: "LONG_INTERVALS", title: "Put" })
  ).id;

  patchActivityId = (
    await insertActivity(user.id, { trainingType: "LONG_INTERVALS", title: "Patch" })
  ).id;
  const seeded = await getDb()
    .insert(intervalSegments)
    .values([
      {
        activityId: patchActivityId,
        segmentIndex: 0,
        setGroupIndex: 0,
        type: "WARMUP",
        targetType: "custom",
        targetValue: 0,
        targetPace: null,
        timeSeriesEndTime: 20,
        actualDistance: 60,
        actualDuration: 20,
        avgHeartRate: 110,
      },
      {
        activityId: patchActivityId,
        segmentIndex: 1,
        setGroupIndex: 1,
        type: "INTERVALS",
        targetType: "distance",
        targetValue: 1000,
        targetPace: 3.2,
        timeSeriesEndTime: 60,
        actualDistance: 120,
        actualDuration: 40,
        avgHeartRate: 140,
      },
    ])
    .returning();
  warmupSegId = seeded[0].id;
  intervalSegId = seeded[1].id;
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(noConsentUser.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

const jsonReq = (url: string, method: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/activity/:id/draft-segments", () => {
  it("404s for a foreign activity", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        new Request("http://test/api/activity/99999999/draft-segments"),
      );
      expect(res.status).toBe(404);
    }));

  it("returns proposedSegments + HR/pace streams with consent", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        new Request(`http://test/api/activity/${draftActivityId}/draft-segments`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proposedSegments).toHaveLength(2);
      expect(body.proposedSegments[0].type).toBe("WARMUP");
      expect(body.streams.time).toEqual([0, 10, 20, 30, 40, 50, 60]);
      expect(body.streams.heartrate).toEqual([100, 110, 120, 130, 140, 150, 160]);
      expect(body.streams.velocity).toEqual([3, 3, 3, 3, 3, 3, 3]);
    }));

  it("returns heartrate=null without HR consent", () =>
    withIdentity(
      { userId: noConsentUser.id, clerkUserId: noConsentUser.clerkId, role: "premium" },
      async () => {
        streamsResult = fullStreams();
        const res = await app.fetch(
          new Request(`http://test/api/activity/${noConsentDraftActivityId}/draft-segments`),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.streams.heartrate).toBeNull();
        expect(body.streams.velocity).toEqual([3, 3, 3, 3, 3, 3, 3]);
      },
    ));
});

describe("PUT /api/activity/:id/segments", () => {
  const validBody = {
    segments: [
      {
        type: "WARMUP",
        setGroupIndex: 0,
        targetType: "custom",
        targetValue: 0,
        targetPace: null,
        timeSeriesEndTime: 20,
      },
      {
        type: "INTERVALS",
        setGroupIndex: 1,
        targetType: "distance",
        targetValue: 1000,
        targetPace: 3.2,
        timeSeriesEndTime: 60,
      },
    ],
  };

  it("404s for a foreign activity", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq("http://test/api/activity/99999999/segments", "PUT", validBody),
      );
      expect(res.status).toBe(404);
    }));

  it("400s when the Strava streams are missing time/distance", () =>
    withIdentity(identity(), async () => {
      streamsResult = {};
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${putActivityId}/segments`, "PUT", validBody),
      );
      expect(res.status).toBe(400);
    }));

  it("400s when a boundary is outside the activity range", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${putActivityId}/segments`, "PUT", {
          segments: [{ ...validBody.segments[0], timeSeriesEndTime: 9999 }],
        }),
      );
      expect(res.status).toBe(400);
    }));

  it("400s for an empty segments array", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${putActivityId}/segments`, "PUT", { segments: [] }),
      );
      expect(res.status).toBe(400);
    }));

  it("replaces segments and returns the recomputed set", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${putActivityId}/segments`, "PUT", validBody),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intervalSegments).toHaveLength(2);
      expect(body.intervalSegments.map((s: { type: string }) => s.type)).toEqual([
        "WARMUP",
        "INTERVALS",
      ]);
      expect(body.intervalSegments[0]).toMatchObject({
        type: "WARMUP",
        timeSeriesEndTime: 20,
        actualDistance: 60,
        actualDuration: 20,
      });
      expect(body.intervalSegments[1]).toMatchObject({
        type: "INTERVALS",
        targetType: "distance",
        targetValue: 1000,
        targetPace: 3.2,
        timeSeriesEndTime: 60,
        actualDistance: 120,
      });
    }));
});

describe("PATCH /api/activity/:id/segments/:segmentId", () => {
  it("404s for a foreign activity", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq("http://test/api/activity/99999999/segments/1", "PATCH", {
          timeSeriesEndTime: 30,
        }),
      );
      expect(res.status).toBe(404);
    }));

  it("404s when the segment id is not on the activity", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${patchActivityId}/segments/99999999`, "PATCH", {
          timeSeriesEndTime: 30,
        }),
      );
      expect(res.status).toBe(404);
    }));

  it("400s for an empty patch body", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${patchActivityId}/segments/${warmupSegId}`, "PATCH", {}),
      );
      expect(res.status).toBe(400);
    }));

  it("moves one boundary and recomputes the whole activity", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/activity/${patchActivityId}/segments/${warmupSegId}`, "PATCH", {
          timeSeriesEndTime: 30,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intervalSegments).toHaveLength(2);
      const warmup = body.intervalSegments.find((s: { type: string }) => s.type === "WARMUP");
      const work = body.intervalSegments.find((s: { type: string }) => s.type === "INTERVALS");
      expect(warmup.timeSeriesEndTime).toBe(30);
      expect(warmup.actualDuration).toBe(30);
      expect(work.actualDuration).toBe(30);
      expect(work.targetPace).toBe(3.2);
    }));
});

describe("POST /api/agents/resume-analysis (editedSegments)", () => {
  it("accepts valid editedSegments", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq("http://test/api/agents/resume-analysis", "POST", {
          activityId: putActivityId,
          notes: "",
          trainingType: "LONG_INTERVALS",
          editedSegments: [
            { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 20 },
            { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 60 },
          ],
        }),
      );
      expect(res.status).toBe(200);
    }));

  it("rejects editedSegments with an invalid type", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq("http://test/api/agents/resume-analysis", "POST", {
          activityId: putActivityId,
          notes: "",
          editedSegments: [{ type: "BOGUS", setGroupIndex: 0, timeSeriesEndTime: 0 }],
        }),
      );
      expect(res.status).toBe(400);
    }));

  it("rejects editedSegments with a negative setGroupIndex", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq("http://test/api/agents/resume-analysis", "POST", {
          activityId: putActivityId,
          notes: "",
          editedSegments: [{ type: "WARMUP", setGroupIndex: -1, timeSeriesEndTime: 0 }],
        }),
      );
      expect(res.status).toBe(400);
    }));
});
