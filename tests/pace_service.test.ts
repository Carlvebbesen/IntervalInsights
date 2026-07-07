// REAL unit tests for the propose-pace algorithm (src/services/pace_service.ts).
//
// ── How this file reaches the REAL implementation ────────────────────────────
// The DEFAULT bun-test preload (tests/setup.ts, wired via bunfig.toml) globally
// mocks ../src/services/pace_service.ts AND ../src/services/lap_derivation_service.ts,
// so every endpoint test runs against stubs and never exercises the real
// algorithm. We must NOT change that (it would break the rest of the suite).
//
// bun's mock.module registry is GLOBAL across files and uses ESM live bindings:
// once any file re-mocks lap_derivation_service, that change retroactively
// clobbers the binding inside an already-loaded real pace_service. So per-file
// bypass tricks (query-suffix imports, in-file re-mocks) are fragile and
// order-dependent in the full suite. Instead this file is run in its OWN
// bun-test invocation with an alternate preload that simply never mocks those
// two modules:
//
//     bun run test:pace            # provisions a disposable Postgres + runs this file
//     # under the hood: scripts/test-pace.sh →
//     #   bun --config=tests/bunfig.pace.toml test tests/pace_service.test.ts
//     # (bunfig.pace.toml preloads tests/setup.pace.ts, which mocks only leaf
//     #  network modules and leaves pace_service / lap_derivation_service REAL.)
//
// Under that config a plain `import` below resolves to the genuine source.
//
// Determinism: interpolatePaces() calls Date.now() internally and we can't
// inject a clock, so history dates are expressed as offsets from Date.now()
// (a few days ago = "recent", >30 days ago = "stale"). The ONE_MONTH_MS window
// is wide enough that these offsets are robust regardless of the exact wall
// clock — no Date.now()/Math.random() stubbing required.

import { afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type z from "zod";
import type { workoutSet } from "../src/agent/initial_analysis_agent";
import {
  generateIntervalSignature,
  mapSetsToIntervalComponent,
} from "../src/services/interval_structure_service";
import { getProposedPaceForStructure, getProposedPaceFromLaps } from "../src/services/pace_service";
import { activities, intervalSegments, intervalStructures } from "../src/schema";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { Lap } from "../src/types/strava/IDetailedActivity";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

type WorkoutSet = z.infer<typeof workoutSet>;

const DAY_MS = 24 * 60 * 60 * 1000;
const recentDate = () => new Date(Date.now() - 3 * DAY_MS); // < 1 month → "recent"
const staleDate = () => new Date(Date.now() - 45 * DAY_MS); // > 1 month → "stale"

// This file is meaningful ONLY under the dedicated preload (tests/setup.pace.ts,
// via `bun run test:pace`) where pace_service is REAL. The default `bun run test`
// suite also discovers this file but runs it under the mocking preload — there
// we detect the stub and SKIP every test (rather than throw and break the run).
const REAL =
  !getProposedPaceFromLaps.toString().includes("=> null") &&
  !getProposedPaceForStructure.toString().includes("=> []");

// Use this in place of bare `describe` so the blocks are skipped when mocked.
const suite = REAL ? describe : describe.skip;

if (!REAL) {
  // One visible breadcrumb so a `bun run test` reader knows where these live.
  describe.skip("pace_service.test.ts (skipped: pace_service is mocked — run `bun run test:pace`)", () => {
    it.skip("see scripts/test-pace.sh + tests/bunfig.pace.toml", () => {});
  });
}

afterAll(async () => {
  await closePool();
});

// ── DB seeding helpers for the history-based path ────────────────────────────

type SeedSegment = {
  segmentIndex: number;
  type?: "INTERVALS" | "WARMUP" | "REST" | "ACTIVE_REST" | "COOL_DOWN";
  targetType: "time" | "distance" | "custom";
  targetValue: number;
  actualDistance: number;
  actualDuration: number;
  targetPace?: number | null;
};

/**
 * Seed one completed activity that links to `structureId`, with the given
 * interval_segments. Returns the activity id. `startDateLocal` controls the
 * recent/stale branch in interpolatePaces.
 */
async function seedActivityWithSegments(
  userId: string,
  structureId: number,
  startDateLocal: Date,
  segs: SeedSegment[],
): Promise<number> {
  const db = getDb();
  const [activity] = await db
    .insert(activities)
    .values({
      userId,
      stravaActivityId: Math.floor(Math.random() * 1e12),
      title: "Seeded interval session",
      sportType: "Run",
      distance: 5000,
      movingTime: 1500,
      startDateLocal,
      analysisStatus: "completed",
      trainingType: "LONG_INTERVALS",
      indoor: false,
      intervalStructureId: structureId,
    })
    .returning();

  await db.insert(intervalSegments).values(
    segs.map((s) => ({
      activityId: activity.id,
      segmentIndex: s.segmentIndex,
      setGroupIndex: 1,
      type: s.type ?? ("INTERVALS" as const),
      targetType: s.targetType,
      targetValue: s.targetValue,
      targetPace: s.targetPace ?? null,
      timeSeriesEndTime: 0,
      actualDistance: s.actualDistance,
      actualDuration: s.actualDuration,
      avgHeartRate: null,
    })),
  );
  return activity.id;
}

/** Seed an interval_structures row whose signature matches `sets`. */
async function seedStructure(sets: WorkoutSet[]): Promise<number> {
  const db = getDb();
  const signature = generateIntervalSignature(mapSetsToIntervalComponent(sets));
  // signature is UNIQUE; reuse if a prior test already inserted it.
  const existing = await db
    .select({ id: intervalStructures.id })
    .from(intervalStructures)
    .where(eq(intervalStructures.signature, signature));
  if (existing[0]) return existing[0].id;
  const [row] = await db
    .insert(intervalStructures)
    .values({ name: `sig ${signature}`, signature })
    .returning();
  return row.id;
}

/** Flatten the nested ExpandedIntervalSet[] step paces for compact assertions. */
function flatPaces(sets: ExpandedIntervalSet[]): (number | null)[] {
  return sets.flatMap((s) => s.steps.map((st) => st.target_pace));
}

// A unique clerk user per describe block keeps the structure-signature lookup
// (which filters by activities.userId) isolated even though signatures are
// globally unique.
async function freshUser() {
  const u = await createTestUser();
  return u;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HISTORY-BASED PATH: getProposedPaceForStructure → interpolatePaces
// ─────────────────────────────────────────────────────────────────────────────

suite("getProposedPaceForStructure (history) — bug surface", () => {
  // ── Bug 6 + units baseline: zero history → all null, shape preserved ───────
  it("BUG 6 / baseline: zero matching history returns structure with every target_pace = null", async () => {
    const user = await freshUser();
    try {
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 3, work_type: "DISTANCE", work_value: 1000 }] },
      ];
      // No structure / activities seeded for this user → empty history.
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      expect(out).toHaveLength(1);
      expect(out[0].steps).toHaveLength(3);
      expect(flatPaces(out)).toEqual([null, null, null]);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  // ── Bug 5 + 1 baseline: m/s contract via actualDistance/actualDuration ─────
  it("BUG 5: aligned recent row yields target_pace in m/s = actualDistance/actualDuration (NOT min/km)", async () => {
    const user = await freshUser();
    try {
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 1, work_type: "DISTANCE", work_value: 1000 }] },
      ];
      const structureId = await seedStructure(sets);
      // 1000 m in 250 s → 4.0 m/s. targetPace null forces the fallback formula.
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        {
          segmentIndex: 1,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 250,
          targetPace: null,
        },
      ]);
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      // 4.0 m/s. A min/km bug would yield ~4.16 (250s/km → 4:10) or 0.24, etc.
      expect(out[0].steps[0].target_pace).toBeCloseTo(4.0, 6);
      // A plausible-but-wrong min/km value must NOT appear.
      expect(out[0].steps[0].target_pace).not.toBeCloseTo(4.16, 2);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("BUG 5: getEffectivePace prefers targetPace over the actual ratio (m/s)", async () => {
    const user = await freshUser();
    try {
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 1, work_type: "DISTANCE", work_value: 1000 }] },
      ];
      const structureId = await seedStructure(sets);
      // ratio would be 1000/200 = 5.0, but explicit targetPace 3.33 must win.
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        {
          segmentIndex: 1,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 200,
          targetPace: 3.33,
        },
      ]);
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      expect(out[0].steps[0].target_pace).toBeCloseTo(3.33, 6);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  // ── Bug 1: zero-duration row must be excluded from the average ─────────────
  it("BUG 1 FIXED: a zero-duration history row is excluded from the average (not poisoning it)", async () => {
    const user = await freshUser();
    try {
      // DISTANCE step with two same-shape DISTANCE history rows: one healthy
      // (4.0 m/s) and one corrupt (actualDuration 0, targetPace null →
      // getEffectivePace null). The null row is dropped, so the proposal is 4.0.
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 1, work_type: "DISTANCE", work_value: 1000 }] },
      ];
      const structureId = await seedStructure(sets);
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        {
          segmentIndex: 1,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 250,
          targetPace: null,
        },
        {
          segmentIndex: 2,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 0,
          targetPace: null,
        },
      ]);
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      const pace = out[0].steps[0].target_pace;
      expect(pace).toBeCloseTo(4.0, 6);
      expect(pace).not.toBeCloseTo(2.0, 2);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  // ── Bug 2: positional matching misaligns identical reps ────────────────────
  it("BUG 2 FIXED: two identical 1000m reps get the SAME pace (recent match preferred, no positional drift)", async () => {
    const user = await freshUser();
    try {
      // Structure: 2x1000m — two IDENTICAL distance reps. A correct algorithm
      // should propose the same pace for both. interpolatePaces indexes
      // sortedRows positionally (flat workIntervalCounter), so step0→rows[0],
      // step1→rows[1]. We seed two activities each contributing one 1000m row at
      // segmentIndex 1; after concat+sort-by-segmentIndex the order is positional
      // and one rep lands on the recent activity, the other on the stale one,
      // which take DIFFERENT branches.
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 2, work_type: "DISTANCE", work_value: 1000 }] },
      ];
      const structureId = await seedStructure(sets);

      // RECENT activity (most recent by startDateLocal → iterated first):
      // 1000 m / 200 s = 5.0 m/s
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        {
          segmentIndex: 1,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 200,
          targetPace: null,
        },
      ]);
      // STALE activity (>30d): 1000 m / 400 s = 2.5 m/s
      await seedActivityWithSegments(user.id, structureId, staleDate(), [
        {
          segmentIndex: 1,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 400,
          targetPace: null,
        },
      ]);

      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      const [p0, p1] = out[0].steps;
      // FIXED: both identical reps match the same pool; the recent activity (5.0)
      // is preferred over the stale one (2.5), so both reps propose 5.0 — identical.
      expect(p0.target_pace).toBeCloseTo(5.0, 6);
      expect(p1.target_pace).toBeCloseTo(5.0, 6);
      expect(p0.target_pace).toBeCloseTo(p1.target_pace as number, 6);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  // ── Bug 3: <1 tolerance is too tight for TIME targets ──────────────────────
  it("BUG 3 FIXED: a 91s history rep aligns to a 90s TIME target (unit-aware tolerance)", async () => {
    const user = await freshUser();
    try {
      // Structure: 1x90s TIME. History: one 91s TIME rep (off by exactly 1s,
      // i.e. essentially the same workout) plus a DISTANCE decoy so that
      // `averagePace` (the not-aligned fallback) differs from the 91s rep's own
      // pace. If alignment were tolerant the step would take the 91s rep's pace
      // (5.0); because <1 fails, it falls back to averagePace and gets a blended
      // value instead — observable proof the 90↔91 match was missed.
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 1, work_type: "TIME", work_value: 90 }] },
      ];
      const structureId = await seedStructure(sets);
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        // The "should-have-matched" 91s rep: targetPace 5.0 m/s
        {
          segmentIndex: 1,
          type: "INTERVALS",
          targetType: "time",
          targetValue: 91,
          actualDistance: 455,
          actualDuration: 91,
          targetPace: 5.0,
        },
        // Decoy DISTANCE rep at pace 3.0 m/s to move the global average.
        {
          segmentIndex: 2,
          type: "INTERVALS",
          targetType: "distance",
          targetValue: 400,
          actualDistance: 400,
          actualDuration: 133,
          targetPace: 3.0,
        },
      ]);
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      const pace = out[0].steps[0].target_pace;
      // FIXED: unit-aware tolerance (max(5s, 5%)) aligns 91s to the 90s target,
      // so the step uses the 91s rep's own pace (5.0), not the blended fallback.
      expect(pace).toBeCloseTo(5.0, 6);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("CONTROL for BUG 3: a 90s rep DOES align to a 90s TIME target (uses the rep's own pace)", async () => {
    const user = await freshUser();
    try {
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 1, work_type: "TIME", work_value: 90 }] },
      ];
      const structureId = await seedStructure(sets);
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        {
          segmentIndex: 1,
          type: "INTERVALS",
          targetType: "time",
          targetValue: 90,
          actualDistance: 450,
          actualDuration: 90,
          targetPace: 5.0,
        },
        {
          segmentIndex: 2,
          type: "INTERVALS",
          targetType: "distance",
          targetValue: 400,
          actualDistance: 400,
          actualDuration: 133,
          targetPace: 3.0,
        },
      ]);
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      // Exact match → recent+aligned → uses the rep's own pace 5.0, not avg 4.0.
      expect(out[0].steps[0].target_pace).toBeCloseTo(5.0, 6);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  // ── Bug 4: cross-type averagePace propagation into a non-aligned step ──────
  it("BUG 4 FIXED: a TIME step with only DISTANCE history proposes null (no cross-type bleed)", async () => {
    const user = await freshUser();
    try {
      // Structure: 1x300s TIME. History: only DISTANCE rows. No row matches by
      // type, so there is no same-shape history for this step → target_pace null
      // (a TIME rep's pace must NOT be derived from distance reps).
      const sets: WorkoutSet[] = [
        { set_reps: 1, steps: [{ reps: 1, work_type: "TIME", work_value: 300 }] },
      ];
      const structureId = await seedStructure(sets);
      await seedActivityWithSegments(user.id, structureId, recentDate(), [
        {
          segmentIndex: 1,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 250,
          targetPace: 4.0,
        },
        {
          segmentIndex: 2,
          targetType: "distance",
          targetValue: 1000,
          actualDistance: 1000,
          actualDuration: 333,
          targetPace: 3.0,
        },
      ]);
      const out = await getProposedPaceForStructure(getDb(), user.id, user.clerkId, sets);
      const pace = out[0].steps[0].target_pace;
      // FIXED: a TIME step with only DISTANCE history has no same-type match, so
      // it proposes null instead of bleeding distance-derived pace into a time rep.
      expect(pace).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  LAP-BASED PATH: getProposedPaceFromLaps (pure; real matchLapsToExpandedSteps)
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal Lap; only fields the algorithm reads are meaningful. */
function lap(overrides: Partial<Lap>): Lap {
  return {
    id: 0,
    resource_state: 2,
    name: "Lap",
    activity: { id: 1, resource_state: 2 },
    athlete: { id: 1, resource_state: 2 },
    elapsed_time: overrides.moving_time ?? 0,
    moving_time: 0,
    start_date: "2026-01-01T00:00:00Z",
    start_date_local: "2026-01-01T00:00:00Z",
    distance: 0,
    start_index: 0,
    end_index: 0,
    total_elevation_gain: 0,
    average_speed: 0,
    max_speed: 0,
    average_cadence: 0,
    device_watts: false,
    average_watts: 0,
    lap_index: 0,
    split: 0,
    ...overrides,
  };
}

suite("getProposedPaceFromLaps (lap-based) — bug 7 surface", () => {
  it("BUG 7a: matched work laps set target_pace = lap.average_speed (m/s)", () => {
    const sets: WorkoutSet[] = [
      { set_reps: 1, steps: [{ reps: 3, work_type: "DISTANCE", work_value: 1000 }] },
    ];
    // 3 work laps at distinct speeds, each ~1000 m (within matcher tolerance).
    const laps: Lap[] = [
      lap({ distance: 1000, moving_time: 200, average_speed: 5.0 }),
      lap({ distance: 1000, moving_time: 220, average_speed: 4.5 }),
      lap({ distance: 1000, moving_time: 250, average_speed: 4.0 }),
    ];
    const out = getProposedPaceFromLaps(laps, sets);
    expect(out).not.toBeNull();
    expect(flatPaces(out as ExpandedIntervalSet[])).toEqual([5.0, 4.5, 4.0]);
  });

  it("BUG 7b: returns null when laps can't be matched (too few laps) — controller then falls back to history", () => {
    const sets: WorkoutSet[] = [
      { set_reps: 1, steps: [{ reps: 3, work_type: "DISTANCE", work_value: 1000 }] },
    ];
    // Only 1 lap for a 3-rep structure → matchLapsToExpandedSteps bails (null).
    const laps: Lap[] = [lap({ distance: 1000, moving_time: 200, average_speed: 5.0 })];
    expect(getProposedPaceFromLaps(laps, sets)).toBeNull();
  });

  it("BUG 7c: step recovery is derived from the gap lap(s) between matched work laps", () => {
    const sets: WorkoutSet[] = [
      {
        set_reps: 1,
        steps: [
          { reps: 2, work_type: "DISTANCE", work_value: 1000, recovery_type: "TIME", recovery_value: 60 },
        ],
      },
    ];
    // work, REST(90s), work — the rest lap is slow so the effort gate skips it.
    const laps: Lap[] = [
      lap({ distance: 1000, moving_time: 200, average_speed: 5.0 }),
      lap({ distance: 200, moving_time: 90, average_speed: 2.2 }), // recovery gap lap
      lap({ distance: 1000, moving_time: 205, average_speed: 4.9 }),
    ];
    const out = getProposedPaceFromLaps(laps, sets);
    expect(out).not.toBeNull();
    const steps = (out as ExpandedIntervalSet[])[0].steps;
    expect(steps.map((s) => s.target_pace)).toEqual([5.0, 4.9]);
    // first rep's recovery overwritten from the 90s gap lap; last rep keeps its 60s.
    expect(steps[0].recovery_value).toBe(90);
    expect(steps[1].recovery_value).toBe(60);
  });

  it("BUG 7d: set_recovery is derived from the gap after the last step of a non-last set", () => {
    const sets: WorkoutSet[] = [
      // 2 sets of a single 1000m rep, set_recovery initially 120.
      {
        set_reps: 2,
        steps: [{ reps: 1, work_type: "DISTANCE", work_value: 1000 }],
        set_recovery: 120,
      },
    ];
    // work, long set-rest(180s slow), work.
    const laps: Lap[] = [
      lap({ distance: 1000, moving_time: 200, average_speed: 5.0 }),
      lap({ distance: 400, moving_time: 180, average_speed: 2.2 }), // between-set gap
      lap({ distance: 1000, moving_time: 205, average_speed: 4.9 }),
    ];
    const out = getProposedPaceFromLaps(laps, sets);
    expect(out).not.toBeNull();
    const result = out as ExpandedIntervalSet[];
    expect(result).toHaveLength(2);
    // first set's set_recovery replaced by the 180s gap; second (last) set keeps 120.
    expect(result[0].set_recovery).toBe(180);
    expect(result[1].set_recovery).toBe(120);
    expect(flatPaces(result)).toEqual([5.0, 4.9]);
  });
});
