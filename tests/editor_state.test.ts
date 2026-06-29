import { describe, expect, it } from "bun:test";
import {
  EditorStateRequestSchema,
  EditorStateResponseSchema,
} from "../src/schemas/api_schemas";

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
