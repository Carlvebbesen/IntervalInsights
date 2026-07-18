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
mock.module("../src/services/pace_anchor_service.ts", () => ({
  fetchPaceAnchor: async () => anchorResult,
}));

const { resolveThresholds } = await import("../src/services/threshold_service");

afterAll(async () => {
  await closePool();
});

function anchorAt(criticalSpeedMps: number | null, source: "critical_speed" | "vdot" | "none"): PaceAnchorResult {
  return {
    status: "ok",
    data: {
      anchorSource: source,
      confidence: "high",
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
