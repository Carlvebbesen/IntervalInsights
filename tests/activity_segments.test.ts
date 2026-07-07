import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
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
let putActivityId: number;

beforeAll(async () => {
  user = await createTestUser({ role: "premium", processHeartRate: true });
  putActivityId = (
    await insertActivity(user.id, { trainingType: "LONG_INTERVALS", title: "Put" })
  ).id;
});

afterAll(async () => {
  await deleteTestUser(user.id);
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

describe("PUT /api/v1/activity/:id/segments", () => {
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
        jsonReq("http://test/api/v1/activity/99999999/segments", "PUT", validBody),
      );
      expect(res.status).toBe(404);
    }));

  it("400s when the Strava streams are missing time/distance", () =>
    withIdentity(identity(), async () => {
      streamsResult = {};
      const res = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${putActivityId}/segments`, "PUT", validBody),
      );
      expect(res.status).toBe(400);
    }));

  it("400s when a boundary is outside the activity range", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${putActivityId}/segments`, "PUT", {
          segments: [{ ...validBody.segments[0], timeSeriesEndTime: 9999 }],
        }),
      );
      expect(res.status).toBe(400);
    }));

  it("400s for an empty segments array", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${putActivityId}/segments`, "PUT", { segments: [] }),
      );
      expect(res.status).toBe(400);
    }));

  it("replaces segments and returns the recomputed set", () =>
    withIdentity(identity(), async () => {
      streamsResult = fullStreams();
      const res = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${putActivityId}/segments`, "PUT", validBody),
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

describe("POST /api/v1/agents/resume-analysis (editedSegments)", () => {
  it("accepts valid editedSegments", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq("http://test/api/v1/agents/resume-analysis", "POST", {
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
        jsonReq("http://test/api/v1/agents/resume-analysis", "POST", {
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
        jsonReq("http://test/api/v1/agents/resume-analysis", "POST", {
          activityId: putActivityId,
          notes: "",
          editedSegments: [{ type: "WARMUP", setGroupIndex: -1, timeSeriesEndTime: 0 }],
        }),
      );
      expect(res.status).toBe(400);
    }));
});
