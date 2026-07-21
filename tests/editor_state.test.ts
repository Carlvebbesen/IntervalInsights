import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  EditorStateRequestSchema,
  EditorStateResponseSchema,
} from "../src/schemas/api_schemas";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const STRUCTURE = [
  {
    set_reps: 1,
    set_recovery: 0,
    steps: [
      { reps: 8, work_type: "DISTANCE", work_value: 1000, recovery_type: "TIME", recovery_value: 60 },
    ],
  },
];

const SETS = [
  {
    set_recovery: 0,
    steps: [
      { work_type: "DISTANCE", work_value: 1000, recovery_type: "TIME", recovery_value: 60, target_pace: 3.5 },
    ],
  },
];

describe("EditorStateRequestSchema — exactly one of structure | sets", () => {
  it("accepts `structure` alone (initial-load mode)", () => {
    const r = EditorStateRequestSchema.safeParse({ structure: STRUCTURE, trainingType: "LONG_INTERVALS" });
    expect(r.success).toBe(true);
  });

  it("accepts `sets` alone (re-derive mode)", () => {
    const r = EditorStateRequestSchema.safeParse({ sets: SETS, trainingType: "LONG_INTERVALS" });
    expect(r.success).toBe(true);
  });

  it("rejects when BOTH structure and sets are present", () => {
    const r = EditorStateRequestSchema.safeParse({
      structure: STRUCTURE,
      sets: SETS,
      trainingType: "LONG_INTERVALS",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when NEITHER structure nor sets is present", () => {
    const r = EditorStateRequestSchema.safeParse({ trainingType: "LONG_INTERVALS" });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown trainingType", () => {
    const r = EditorStateRequestSchema.safeParse({ structure: STRUCTURE, trainingType: "NOT_A_TYPE" });
    expect(r.success).toBe(false);
  });

  it("treats includeStreams as optional", () => {
    const withFlag = EditorStateRequestSchema.safeParse({
      sets: SETS,
      trainingType: "LONG_INTERVALS",
      includeStreams: false,
    });
    expect(withFlag.success).toBe(true);
    if (withFlag.success) expect(withFlag.data.includeStreams).toBe(false);
  });
});

describe("EditorStateResponseSchema", () => {
  it("accepts a full response with streams", () => {
    const r = EditorStateResponseSchema.safeParse({
      sets: SETS,
      segments: [
        {
          segmentIndex: 0,
          setGroupIndex: 0,
          type: "INTERVALS",
          timeSeriesEndTime: 300,
          actualDistance: 1000,
          actualDuration: 300,
          avgHeartRate: 160,
          targetType: "distance",
          targetValue: 1000,
          targetPace: 3.5,
        },
      ],
      streams: { time: [0, 1, 2], heartrate: [150, 152, 155], velocity: [3.3, 3.4, 3.5] },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a response with null streams (includeStreams:false / re-derive)", () => {
    const r = EditorStateResponseSchema.safeParse({ sets: SETS, segments: [], streams: null });
    expect(r.success).toBe(true);
  });

  it("accepts null heartrate within streams (no HR consent)", () => {
    const r = EditorStateResponseSchema.safeParse({
      sets: SETS,
      segments: [],
      streams: { time: [0], heartrate: null, velocity: [3.3] },
    });
    expect(r.success).toBe(true);
  });
});

describe("POST /api/v1/activity/:id/editor-state (endpoint)", () => {
  const app = buildTestApp(getPool());

  let user: { id: string; email: string };
  let otherUser: { id: string; email: string };
  let activityId: number;
  let foreignActivityId: number;

  // Monkeypatch the (mocked) stravaApiService object so `sets` mode has real
  // time/distance streams to derive segments from; restored after the suite.
  const realGetActivityStreams = stravaApiService.getActivityStreams;
  const realGetActivityLaps = stravaApiService.getActivityLaps;

  beforeAll(async () => {
    user = await createTestUser({ role: "premium" });
    otherUser = await createTestUser({ role: "premium" });
    activityId = (await insertActivity(user.id, { trainingType: "LONG_INTERVALS" })).id;
    foreignActivityId = (
      await insertActivity(otherUser.id, { trainingType: "LONG_INTERVALS" })
    ).id;

    const n = 600;
    stravaApiService.getActivityStreams = (async () => ({
      time: { data: Array.from({ length: n }, (_, i) => i) },
      distance: { data: Array.from({ length: n }, (_, i) => i * 3) },
      velocity_smooth: { data: Array.from({ length: n }, () => 3) },
    })) as typeof stravaApiService.getActivityStreams;
    stravaApiService.getActivityLaps = (async () =>
      []) as typeof stravaApiService.getActivityLaps;
  });

  afterAll(async () => {
    stravaApiService.getActivityStreams = realGetActivityStreams;
    stravaApiService.getActivityLaps = realGetActivityLaps;
    await deleteTestUser(user.id);
    await deleteTestUser(otherUser.id);
    await closePool();
  });

  const identity = () => ({
    userId: user.id,
    role: "premium" as const,
  });

  const post = (id: number, body: unknown) =>
    app.fetch(
      new Request(`http://test/api/v1/activity/${id}/editor-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("400s when BOTH structure and sets are sent", () =>
    withIdentity(identity(), async () => {
      const res = await post(activityId, {
        structure: STRUCTURE,
        sets: SETS,
        trainingType: "LONG_INTERVALS",
      });
      expect(res.status).toBe(400);
    }));

  it("400s when NEITHER structure nor sets is sent", () =>
    withIdentity(identity(), async () => {
      const res = await post(activityId, { trainingType: "LONG_INTERVALS" });
      expect(res.status).toBe(400);
    }));

  it("404s for another user's activity id", () =>
    withIdentity(identity(), async () => {
      const res = await post(foreignActivityId, {
        sets: SETS,
        trainingType: "LONG_INTERVALS",
      });
      expect(res.status).toBe(404);
    }));

  it("passes supplied `sets` paces through verbatim (re-derive mode)", () =>
    withIdentity(identity(), async () => {
      const pacedSets = [
        {
          set_recovery: 0,
          steps: [
            {
              work_type: "DISTANCE",
              work_value: 400,
              recovery_type: "TIME",
              recovery_value: 60,
              target_pace: 3.5,
            },
            {
              work_type: "DISTANCE",
              work_value: 400,
              recovery_type: "TIME",
              recovery_value: 60,
              target_pace: 4.25,
            },
          ],
        },
      ];
      const res = await post(activityId, {
        sets: pacedSets,
        trainingType: "LONG_INTERVALS",
        includeStreams: false,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The paces the client sent are the paces it gets back — never recomputed.
      expect(body.sets).toHaveLength(1);
      expect(body.sets[0].steps.map((s: { target_pace: number }) => s.target_pace)).toEqual([
        3.5, 4.25,
      ]);
      expect(body.streams).toBeNull();
      expect(Array.isArray(body.segments)).toBe(true);
    }));
});
