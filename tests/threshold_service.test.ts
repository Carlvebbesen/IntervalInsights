import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PaceAnchorResult } from "../src/services/pace_anchor_service";
import { getOrCreateUserSettings, updateUserSettings } from "../src/repositories/user_settings_repository";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

// Mutable stubs — each test sets these before calling resolveThresholds.
let athleteResponse: unknown = { id: "i1", sportSettings: [], lthr: null };
let wellnessResponse: unknown[] = [];
let athleteShouldThrow = false;

mock.module("../src/services/intervals_api_service.ts", () => ({
  DEFAULT_INTERVALS_STREAM_TYPES: [],
  intervalsApiService: {
    getAthlete: async () => {
      if (athleteShouldThrow) throw new Error("intervals down");
      return athleteResponse;
    },
    getWellness: async () => wellnessResponse,
  },
}));

let anchorResult: PaceAnchorResult = { status: "not_linked", data: null };
let anchorByDate: ((now: Date) => PaceAnchorResult) | null = null;
mock.module("../src/services/pace_anchor_service.ts", () => ({
  fetchPaceAnchor: async (_db: unknown, _userId: string, now: Date = new Date()) =>
    anchorByDate ? anchorByDate(now) : anchorResult,
}));

const { resolveThresholds, buildHistoricalThresholdResolver, nearestRestingHrAtOrBefore } =
  await import("../src/services/threshold_service");

afterAll(async () => {
  await closePool();
});

function anchorAt(
  criticalSpeedMps: number | null,
  source: "critical_speed" | "vdot" | "none",
  confidence: "high" | "medium" | "low" = "high",
): PaceAnchorResult {
  return {
    status: "ok",
    data: {
      anchorSource: source,
      confidence,
      criticalSpeedMps,
      dPrimeM: null,
      vdot: null,
      paces: { easySecPerKm: null, thresholdSecPerKm: null, intervalSecPerKm: null, repSecPerKm: null },
      predictedRaces: [],
    },
  };
}

describe("resolveThresholds", () => {
  beforeEach(() => {
    athleteResponse = { id: "i1", sportSettings: [], lthr: null };
    wellnessResponse = [];
    athleteShouldThrow = false;
    anchorResult = { status: "not_linked", data: null };
    anchorByDate = null;
  });

  it("manual threshold pace override wins over the pace anchor", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { thresholdPaceMps: 3.7, lthr: 160, restingHr: 45 });
      anchorResult = anchorAt(4.2, "critical_speed");

      const res = await resolveThresholds(db, user.id);
      expect(res.thresholdPaceMps).toBe(3.7);
      expect(res.thresholdPaceSource).toBe("manual");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("falls back to the critical-speed anchor when no manual override", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { lthr: 160, restingHr: 45 });
      anchorResult = anchorAt(4.05, "critical_speed");

      const res = await resolveThresholds(db, user.id);
      expect(res.thresholdPaceMps).toBe(4.05);
      expect(res.thresholdPaceSource).toBe("pace_anchor");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("ignores a non-critical-speed anchor (thresholdPace stays null)", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { lthr: 160, restingHr: 45 });
      anchorResult = anchorAt(null, "vdot");

      const res = await resolveThresholds(db, user.id);
      expect(res.thresholdPaceMps).toBeNull();
      expect(res.thresholdPaceSource).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("seed-once fills only null HR fields from intervals.icu and persists them", async () => {
    const user = await createTestUser({ role: "premium", maxHeartRate: 190 });
    try {
      const db = getDb();
      // lthr already set → must be preserved; restingHr null → seeded from wellness.
      await updateUserSettings(db, user.id, { lthr: 158 });
      athleteResponse = {
        id: "i1",
        lthr: 170,
        sportSettings: [{ types: ["Run"], lthr: 165, hr_zones: null, hr_zone_names: null, max_hr: null }],
      };
      wellnessResponse = [
        { id: "2026-07-01", restingHR: 50 },
        { id: "2026-07-10", restingHR: 44 },
      ];

      const res = await resolveThresholds(db, user.id);
      expect(res.lthr).toBe(158); // preserved, not overwritten by 165
      expect(res.restingHr).toBe(44); // latest non-null seeded
      expect(res.maxHr).toBe(190);

      const persisted = await getOrCreateUserSettings(db, user.id);
      expect(persisted.lthr).toBe(158);
      expect(persisted.restingHr).toBe(44);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("seeds lthr from the running sport settings when settings lthr is null", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      athleteResponse = {
        id: "i1",
        lthr: 170,
        sportSettings: [{ types: ["Run"], lthr: 162, hr_zones: null, hr_zone_names: null, max_hr: null }],
      };
      wellnessResponse = [{ id: "2026-07-10", restingHR: 48 }];

      const res = await resolveThresholds(db, user.id);
      expect(res.lthr).toBe(162);
      expect(res.restingHr).toBe(48);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("intervals.icu failure during seed → HR fields stay null, no throw", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      athleteShouldThrow = true;

      const res = await resolveThresholds(db, user.id);
      expect(res.lthr).toBeNull();
      expect(res.restingHr).toBeNull();

      const persisted = await getOrCreateUserSettings(db, user.id);
      expect(persisted.lthr).toBeNull();
      expect(persisted.restingHr).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("no intervals link → no seed attempt, HR fields reflect settings", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      const db = getDb();
      const res = await resolveThresholds(db, user.id);
      expect(res.lthr).toBeNull();
      expect(res.restingHr).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("passes ftp and sex through from settings", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, {
        ftp: 275,
        sex: "female",
        lthr: 160,
        restingHr: 45,
      });
      const res = await resolveThresholds(db, user.id);
      expect(res.ftp).toBe(275);
      expect(res.sex).toBe("female");
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("nearestRestingHrAtOrBefore", () => {
  const history = [
    { date: "2020-01-01", restingHr: 50 },
    { date: "2020-06-01", restingHr: 48 },
    { date: "2021-01-01", restingHr: 45 },
  ];

  it("forward-fills the nearest record at-or-before the date", () => {
    expect(nearestRestingHrAtOrBefore(history, "2020-03-15")).toBe(50);
    expect(nearestRestingHrAtOrBefore(history, "2020-06-01")).toBe(48); // exact match
    expect(nearestRestingHrAtOrBefore(history, "2025-01-01")).toBe(45); // latest before
  });

  it("returns null before the first record and for empty history", () => {
    expect(nearestRestingHrAtOrBefore(history, "2019-12-31")).toBeNull();
    expect(nearestRestingHrAtOrBefore([], "2020-01-01")).toBeNull();
  });
});

describe("buildHistoricalThresholdResolver", () => {
  beforeEach(() => {
    athleteResponse = { id: "i1", sportSettings: [], lthr: null };
    wellnessResponse = [];
    athleteShouldThrow = false;
    anchorResult = { status: "not_linked", data: null };
    anchorByDate = null;
  });

  it("manual pace override wins for every historical date", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { thresholdPaceMps: 3.5, lthr: 160, restingHr: 45 });
      anchorByDate = () => anchorAt(4.2, "critical_speed");

      const resolver = await buildHistoricalThresholdResolver(db, user.id);
      const past = await resolver(new Date("2015-06-01T00:00:00Z"));
      expect(past.thresholdPaceMps).toBe(3.5);
      expect(past.thresholdPaceSource).toBe("manual");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("forward-fills restingHr from wellness history without persisting it", async () => {
    const user = await createTestUser({ role: "premium", maxHeartRate: 190 });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { lthr: 160, restingHr: 55 });
      wellnessResponse = [
        { id: "2014-01-01", restingHR: 52 },
        { id: "2016-01-01", restingHR: 47 },
      ];
      const before = await getOrCreateUserSettings(db, user.id);

      const resolver = await buildHistoricalThresholdResolver(db, user.id);
      const mid = await resolver(new Date("2015-06-01T00:00:00Z"));
      expect(mid.restingHr).toBe(52); // forward-filled from 2014 record

      const later = await resolver(new Date("2017-01-01T00:00:00Z"));
      expect(later.restingHr).toBe(47);

      // Before any wellness record → falls back to the current settings value.
      const early = await resolver(new Date("2013-01-01T00:00:00Z"));
      expect(early.restingHr).toBe(55);

      const after = await getOrCreateUserSettings(db, user.id);
      expect(after.restingHr).toBe(before.restingHr); // never persisted
      expect(after.lthr).toBe(160);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("falls back to the current-day threshold pace when the anchor has no data that far back", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { lthr: 160, restingHr: 45 });
      // Current day resolves a critical-speed anchor; the historical date does not.
      anchorByDate = (now) =>
        now.getUTCFullYear() >= 2024 ? anchorAt(4.1, "critical_speed") : { status: "not_linked", data: null };

      const resolver = await buildHistoricalThresholdResolver(db, user.id);
      const past = await resolver(new Date("2012-01-01T00:00:00Z"));
      expect(past.thresholdPaceMps).toBe(4.1); // current-day fallback
      expect(past.thresholdPaceSource).toBe("pace_anchor");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("rejects medium-confidence historical anchors, falling back to the current-day pace", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { lthr: 160, restingHr: 45 });
      // Current day: high-confidence 4.2; historical windows: medium-confidence 3.2.
      anchorByDate = (now) =>
        now.getUTCFullYear() >= 2026
          ? anchorAt(4.2, "critical_speed", "high")
          : anchorAt(3.2, "critical_speed", "medium");

      const resolver = await buildHistoricalThresholdResolver(db, user.id);
      const past = await resolver(new Date("2020-06-01T00:00:00Z"));
      expect(past.thresholdPaceMps).toBe(4.2);
      expect(past.thresholdPaceSource).toBe("pace_anchor");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("re-derives the pace anchor as-of each historical date when data exists", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await updateUserSettings(db, user.id, { lthr: 160, restingHr: 45 });
      anchorByDate = (now) =>
        anchorAt(now.getUTCFullYear() >= 2020 ? 4.5 : 3.8, "critical_speed");

      const resolver = await buildHistoricalThresholdResolver(db, user.id);
      const early = await resolver(new Date("2016-06-01T00:00:00Z"));
      const late = await resolver(new Date("2022-06-01T00:00:00Z"));
      expect(early.thresholdPaceMps).toBe(3.8);
      expect(late.thresholdPaceMps).toBe(4.5);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
