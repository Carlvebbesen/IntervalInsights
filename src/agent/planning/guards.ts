import { AppError } from "../../error";
import type { TrainingType } from "../../schema/enums";
import { INTERVAL_TRAINING_TYPES, type PlanWeekPhase, trainingBucketFor } from "../../schema/enums";
import type { WorkoutStructureSet } from "../../schemas/agent_schemas";
import {
  addDaysISO,
  daysBetweenISO,
  mondayOfISO,
  parseISODateUTC,
  toISODate,
} from "../../services/utils";
import type {
  GeneratedSession,
  PlanMacro,
  PlanMacroWeek,
  PlanNotice,
} from "./plan_builder_schemas";
import type {
  IntensityAggressiveness,
  PlanBuilderInput,
  VolumeAggressiveness,
} from "./plan_builder_state";

// ~2.78 m/s — 5 km in 30 min. Used to approximate distance for TIME-based work
// so a week's estimated volume is comparable regardless of how a step is typed.
export const EASY_PACE_MPS = 5000 / 1800;

const MAX_SESSIONS_PER_WEEK = 7;

/** Monday-aligned week starts (YYYY-MM-DD) whose weeks cover startDate..endDate. */
export function expectedWeekStarts(startDate: string, endDate: string): string[] {
  const lastMonday = mondayOfISO(endDate);
  const out: string[] = [];
  for (let cur = mondayOfISO(startDate); cur <= lastMonday; cur = addDaysISO(cur, 7)) {
    out.push(cur);
  }
  return out;
}

/**
 * Clamp a date into [weekStart, weekStart+6] (its Monday-aligned week bounds).
 * An unparsable date falls back to the week start — a NaN date fails BOTH bound
 * comparisons, so returning it unchanged would pass malformed text through to
 * the persisted session.
 */
export function repairSessionDate(date: string, weekStart: string): string {
  const d = parseISODateUTC(date);
  const start = parseISODateUTC(weekStart);
  const end = parseISODateUTC(addDaysISO(weekStart, 6));
  if (Number.isNaN(d.getTime())) return toISODate(start);
  if (d < start) return toISODate(start);
  if (d > end) return toISODate(end);
  return date;
}

// Comeback lane: an athlete with PROVEN capacity (a sustained block in the last
// ~6 months) may return toward it far faster than a novice may build — the
// tissue adaptation exists, it is regained, not created. While the running
// reference (prior week / running peak) is below 85% of proven weekly volume,
// the effective ramp ceiling is 30% regardless of the aggressiveness dial; the
// fast lane ends AT that 85% threshold, above which normal ceilings apply.
export const RETURN_RAMP_CEILING = 0.3;
export const PROVEN_RETURN_THRESHOLD = 0.85;
// A comeback long run is referenced against proven history, discounted 20% —
// not pinned to a vacation-shrunken 30-day longest.
export const PROVEN_LONGEST_RUN_FACTOR = 0.8;

/** Max the return lane allows off `reference`; 0 when proven capacity does not apply. */
function returnRampMax(reference: number, provenWeeklyMeters: number | null | undefined): number {
  if (provenWeeklyMeters == null || !Number.isFinite(provenWeeklyMeters)) return 0;
  const threshold = Math.floor(provenWeeklyMeters * PROVEN_RETURN_THRESHOLD);
  if (reference >= threshold || reference <= 0) return 0;
  return Math.min(Math.round(reference * (1 + RETURN_RAMP_CEILING)), threshold);
}

/**
 * The burst bookkeeping every ramp loop shares: `reference` is what the next
 * week's allowance is measured off (the running peak, or the prior week for the
 * prev-relative clamp) and `allowed` is the ceiling fraction the next week may
 * use — `burst` until a week overshoots the plain ceiling and spends it.
 */
type RampTracker = { reference: number; allowed: number };

function advanceRamp(
  tracker: RampTracker,
  emitted: number,
  ceiling: number,
  burst: number,
  nextReference = Math.max(tracker.reference, emitted),
): RampTracker {
  return {
    reference: nextReference,
    allowed: emitted > Math.round(tracker.reference * (1 + ceiling)) ? ceiling : burst,
  };
}

/**
 * Clamp each week-over-week increase to `ceiling`, tolerating a single one-off
 * jump up to `burst` when the previous week did not itself burst — so a
 * progressive plan can step up once without sustaining a spike. Recovery drops
 * (any week below the prior) always pass through. Ceilings/bursts are fractions
 * (0.10 = +10%). `provenWeeklyMeters` opens the comeback return lane (see
 * `RETURN_RAMP_CEILING`).
 */
export function clampWeeklyRamp(
  targets: number[],
  ceiling: number,
  burst: number,
  provenWeeklyMeters: number | null = null,
): number[] {
  const out = [...targets];
  let t: RampTracker = { reference: out[0] ?? 0, allowed: burst };
  for (let i = 1; i < out.length; i++) {
    const max = Math.max(
      Math.round(t.reference * (1 + t.allowed)),
      returnRampMax(t.reference, provenWeeklyMeters),
    );
    if (out[i] > max) out[i] = max;
    // Prev-relative: the next reference is the emitted week itself, not the peak.
    t = advanceRamp(t, out[i], ceiling, burst, out[i]);
  }
  return out;
}

/**
 * The ramp invariant enforced on the FINAL shaped output, measured against the
 * running PEAK of the preceding weeks rather than the immediately prior week.
 *
 * Why peak-relative: later shaping stages (`enforceDownWeeks`, `capLongestRunSpike`,
 * `capMaxWeekly`) lower individual weeks, which re-opens headroom a purely
 * prev-relative clamp already spent.
 * Re-clamping against the prior week instead would flatten the plan into
 * the down week and destroy the recovery-then-rebuild shape. Stepping back up to
 * the pre-down-week peak after a recovery week is the intended (and
 * physiologically correct) block-periodization shape; what must never happen is
 * exceeding the ceiling relative to the trajectory the athlete had already
 * reached. So: no week may exceed the highest week before it by more than
 * `ceiling` (one `burst` tolerated, as in `clampWeeklyRamp`), except for the
 * two explicit allowances in `RampAllowanceOpts`.
 */
export type RampAllowanceOpts = {
  /** Opens the comeback return lane (see `RETURN_RAMP_CEILING`). */
  provenWeeklyMeters?: number | null;
  /**
   * Permits one full quantization grid step above the running peak even where
   * the percentage ceiling is tighter — without it, coarse-grid plans whose
   * ceiling headroom is smaller than one grid step (e.g. steady at 30–50 km/wk)
   * could never step at all. The plateau-then-step contract of
   * `quantizeWeeklyTargets`; only meaningful on quantized arrays.
   */
  gridStep?: boolean;
};

/** The max a week may reach off the running `peak` under `allowed` plus the opt-in allowances. */
export function peakRampAllowance(
  peak: number,
  allowed: number,
  opts: RampAllowanceOpts = {},
): number {
  return Math.max(
    Math.round(peak * (1 + allowed)),
    returnRampMax(peak, opts.provenWeeklyMeters),
    opts.gridStep ? peak + rampGridStepFor(peak) : 0,
  );
}

export function clampRampAgainstPeak(
  targets: number[],
  ceiling: number,
  burst: number,
  opts: RampAllowanceOpts = {},
): number[] {
  const out = [...targets];
  let t: RampTracker = { reference: out[0] ?? 0, allowed: burst };
  for (let i = 1; i < out.length; i++) {
    const max = peakRampAllowance(t.reference, t.allowed, opts);
    if (out[i] > max) out[i] = max;
    t = advanceRamp(t, out[i], ceiling, burst);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-baseline-anchored macro volume shaping (the anti-over-ramp injury guard).
// Pure functions over a weekly-target array; the node passes context values in.
// Constants are research-backed but tunable.
// ─────────────────────────────────────────────────────────────────────────────

// No recent running on record → anchor week 1 to a conservative re-entry floor
// rather than the race goal. ~20 km/wk is a safe restart base.
export const DEFAULT_BASELINE_WEEKLY_METERS = 20_000;

// Below this, a computed trailing average is not a training baseline — it is an
// artefact of a near-empty 28-day window (see gather_context's minimum-evidence
// rule, which shares this constant). Treated as ABSENT so the default anchors.
export const MIN_BASELINE_WEEKLY_METERS = 5_000;

// Below this, a WEEKLY TARGET is missing/garbage LLM data rather than a coaching
// choice — a sub-kilometre week is not a prescription. Well under the smallest
// value the pipeline can legitimately produce (a taper week off the minimum
// baseline is ~1.4 km), so this only ever screens raw LLM output.
export const MIN_PLAUSIBLE_WEEKLY_METERS = 1_000;

// Weekly ramp ceilings by the volume-aggressiveness dial. 10%/wk is the classic
// (folklore-but-standard) safe-progression rule; gradual/progressive bracket it.
// `burst` is a one-off week-over-week jump the clamp tolerates once — only
// meaningfully above `ceiling` for progressive (a single ~25% step-up).
export const VOLUME_RAMP: Record<VolumeAggressiveness, { ceiling: number; burst: number }> = {
  gradual: { ceiling: 0.07, burst: 0.07 },
  steady: { ceiling: 0.1, burst: 0.1 },
  progressive: { ceiling: 0.15, burst: 0.25 },
};

// Weekly volumes are emitted on a coarse step grid — real plans hold plateaus
// and take visible steps (50, 50, 60, 70 …), they do not creep 18.2 → 19.5 km.
export const QUANT_GRID_THRESHOLD_METERS = 30_000;
export const QUANT_GRID_BELOW_METERS = 2_000;
export const QUANT_GRID_ABOVE_METERS = 5_000;
// A step within this band of the previous build week is noise, not a step —
// flattened to an exact plateau.
export const PLATEAU_BAND = 0.08;

/** The step grid a weekly volume quantizes to: 2 km below 30 km/wk, 5 km at/above. */
export function quantGridFor(meters: number): number {
  return meters < QUANT_GRID_THRESHOLD_METERS ? QUANT_GRID_BELOW_METERS : QUANT_GRID_ABOVE_METERS;
}

/**
 * The grid step the ramp allowance grants above a running peak. Keyed off the
 * peak (not the candidate value) so the allowance is well-defined before the
 * step lands; the −2 km margin keeps a small-grid peak from granting a
 * large-grid step across the 30 km boundary.
 */
export function rampGridStepFor(peakMeters: number): number {
  return peakMeters < QUANT_GRID_THRESHOLD_METERS - QUANT_GRID_BELOW_METERS
    ? QUANT_GRID_BELOW_METERS
    : QUANT_GRID_ABOVE_METERS;
}

// Fraction of weekly running volume a single long run typically represents —
// used to derive an "implied longest run" from a week's target.
export const IMPLIED_LONG_RUN_FRACTION = 0.35;
// Nielsen/RUNSAFE: a sudden long-run jump is a stronger injury signal than
// weekly volume. Cap the implied long run at +30% over the real recent longest,
// letting that ceiling itself grow ~10%/week so the plan can still progress.
export const LONG_RUN_SPIKE_CAP = 0.3;
export const LONG_RUN_WEEKLY_GROWTH = 0.1;

// A recovery/down week every 4th build week at ~72% of the prior week's volume.
export const DOWN_WEEK_CADENCE = 4;
export const DOWN_WEEK_FACTOR = 0.72;

/**
 * Cap week 1 at the athlete's REAL trailing baseline — never the race goal.
 * Starting above what they are actually running is the top cause of over-ramp
 * injury. A pure CEILING: a plausible LLM week 1 below the baseline is
 * preserved — under-anchoring is the safe direction, the ramp grows the plan
 * from there. The `DEFAULT_BASELINE_WEEKLY_METERS` ceiling applies ONLY when
 * there is no usable data at all; below `MIN_PLAUSIBLE_WEEKLY_METERS` the
 * LLM's week 1 is missing data rather than a small training week, and the
 * usable baseline is used outright.
 */
export function anchorWeekOne(targets: number[], baselineWeeklyMeters: number | null): number[] {
  if (targets.length === 0) return targets;
  const usable =
    baselineWeeklyMeters != null &&
    Number.isFinite(baselineWeeklyMeters) &&
    baselineWeeklyMeters >= MIN_PLAUSIBLE_WEEKLY_METERS
      ? baselineWeeklyMeters
      : DEFAULT_BASELINE_WEEKLY_METERS;
  const out = [...targets];
  out[0] =
    out[0] >= MIN_PLAUSIBLE_WEEKLY_METERS
      ? Math.min(Math.round(out[0]), Math.round(usable))
      : Math.round(usable);
  return out;
}

/**
 * A weekly target below `MIN_PLAUSIBLE_WEEKLY_METERS` is missing LLM data, not a
 * prescribed rest week — carry the previous week forward rather than leaving a
 * hole. Without this a single garbage `0` or `1` propagates for the rest of the
 * plan, because the ramp clamp lets every drop through untouched. Flat, so it
 * invents no ramp; the deliberate drops (down weeks, taper) are applied later.
 */
export function floorWeeklyTargets(targets: number[]): number[] {
  const out = [...targets];
  for (let i = 1; i < out.length; i++) {
    if (!(out[i] >= MIN_PLAUSIBLE_WEEKLY_METERS)) out[i] = out[i - 1];
  }
  return out;
}

/**
 * The long-run reference the spike cap grows off: the recent (30-day) longest,
 * or 80% of the proven 6-month longest when that is larger — a comeback
 * athlete's long runs are not pinned to a vacation-shrunken 30-day window.
 * Null when neither exists.
 */
export function longRunSpikeReference(
  longestRunMeters: number | null,
  provenLongestRunMeters: number | null = null,
): number | null {
  const recent = longestRunMeters != null && longestRunMeters > 0 ? longestRunMeters : 0;
  const proven =
    provenLongestRunMeters != null && provenLongestRunMeters > 0
      ? provenLongestRunMeters * PROVEN_LONGEST_RUN_FACTOR
      : 0;
  const ref = Math.max(recent, proven);
  return ref > 0 ? ref : null;
}

/**
 * The weekly-volume ceiling the long-run spike cap implies for week `weekIdx`
 * (0-based): the long-run ceiling — `spikeRef` grown by the spike cap and the
 * weekly growth rate — converted to week volume via the implied long-run
 * fraction. Unrounded; callers round. Single source for `capLongestRunSpike`
 * and `quantizeWeeklyTargets`, whose caps must stay identical.
 */
export function longRunWeekVolumeCeiling(spikeRef: number, weekIdx: number): number {
  return (
    (spikeRef * (1 + LONG_RUN_SPIKE_CAP) * (1 + LONG_RUN_WEEKLY_GROWTH) ** weekIdx) /
    IMPLIED_LONG_RUN_FRACTION
  );
}

/**
 * Cap each week's IMPLIED longest run (a fixed fraction of weekly volume) at a
 * ceiling that grows off the athlete's real recent longest run (or the proven
 * 6-month reference, see `longRunSpikeReference`); scale the week's volume down
 * proportionally when it would spike the long run too fast. No-op without a
 * known reference.
 */
export function capLongestRunSpike(
  targets: number[],
  longestRunMeters: number | null,
  provenLongestRunMeters: number | null = null,
): number[] {
  const ref = longRunSpikeReference(longestRunMeters, provenLongestRunMeters);
  if (ref == null) return targets;
  const out = [...targets];
  for (let i = 0; i < out.length; i++) {
    const ceiling = longRunWeekVolumeCeiling(ref, i);
    if (out[i] > ceiling) out[i] = Math.round(ceiling);
  }
  return out;
}

/**
 * The 0-based indices that are recovery/down weeks: every `DOWN_WEEK_CADENCE`th
 * build week, bounded by `buildWeeks` so taper weeks (the tail) keep their own
 * shaping.
 */
export function downWeekIndicesFor(buildWeeks: number, length: number): Set<number> {
  const indices = new Set<number>();
  for (let i = 1; i < Math.min(buildWeeks, length); i++) {
    if ((i + 1) % DOWN_WEEK_CADENCE === 0) indices.add(i);
  }
  return indices;
}

/**
 * Insert a recovery week at each `downWeekIndicesFor` index, at
 * `DOWN_WEEK_FACTOR` of the prior week.
 */
export function enforceDownWeeks(targets: number[], buildWeeks = targets.length): number[] {
  const out = [...targets];
  for (const i of downWeekIndicesFor(buildWeeks, out.length)) {
    out[i] = Math.round(out[i - 1] * DOWN_WEEK_FACTOR);
  }
  return out;
}

/** Final hard ceiling: no week exceeds the user's `maxWeeklyVolumeMeters`. */
export function capMaxWeekly(targets: number[], maxWeeklyVolumeMeters: number | null): number[] {
  if (maxWeeklyVolumeMeters == null) return targets;
  return targets.map((t) => Math.min(t, maxWeeklyVolumeMeters));
}

export type QuantizeWeeklyOpts = {
  ceiling: number;
  burst: number;
  provenWeeklyMeters?: number | null;
  maxWeeklyVolumeMeters: number | null;
  longestRunMeters: number | null;
  provenLongestRunMeters?: number | null;
  /** Deliberate recovery dips: re-quantized on the grid, never plateau-flattened or used as a plateau anchor. */
  downWeekIndices: ReadonlySet<number>;
  /** Weeks at/after this index (the taper/race tail) are left untouched. */
  taperStartIndex: number;
};

/**
 * Plateau-and-step quantization: every build-week target snaps to the step grid
 * (`quantGridFor`), and a rounded step within `PLATEAU_BAND` of the previous
 * build week flattens to an exact plateau — real plans hold volume flat and
 * take visible steps, they never creep a few percent a week.
 *
 * Rounding may only step UP where the caps allow: the ramp/burst ceiling off
 * the running emitted peak (plus the return lane and the one-grid-step
 * allowance — see `peakRampAllowance`), the long-run spike ceiling, and the
 * user's hard max. A step above the percentage ceiling additionally requires
 * the incoming (pre-quantized) trajectory to have itself reached the grid
 * point, which is what turns a clamped smooth ramp into plateau-then-step
 * instead of a permanently flat line. When rounding up would breach a cap, the
 * week rounds down instead. Mirrors `clampRampAgainstPeak`'s peak/burst
 * tracking exactly so the final re-clamp is a no-op on the emitted array.
 */
export function quantizeWeeklyTargets(targets: number[], opts: QuantizeWeeklyOpts): number[] {
  const out = [...targets];
  const spikeRef = longRunSpikeReference(
    opts.longestRunMeters,
    opts.provenLongestRunMeters ?? null,
  );
  const staticCap = (i: number): number => {
    let cap = Number.POSITIVE_INFINITY;
    if (opts.maxWeeklyVolumeMeters != null) cap = Math.min(cap, opts.maxWeeklyVolumeMeters);
    if (spikeRef != null) cap = Math.min(cap, Math.round(longRunWeekVolumeCeiling(spikeRef, i)));
    return cap;
  };
  let t: RampTracker = { reference: 0, allowed: opts.burst };
  let prevBuild: number | null = null;
  const end = Math.min(out.length, Math.max(0, opts.taperStartIndex));
  for (let i = 0; i < end; i++) {
    const raw = out[i];
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const isDown = opts.downWeekIndices.has(i);
    // A down week dips off its QUANTIZED neighbour: the pre-quantization dip
    // (0.72 × an unrounded week) can land above the rounded-down week before
    // it, erasing the recovery shape.
    const v =
      isDown && i > 0 && Number.isFinite(out[i - 1]) && out[i - 1] > 0
        ? out[i - 1] * DOWN_WEEK_FACTOR
        : raw;
    const grid = quantGridFor(v);
    // Week 1 anchors to the real baseline — quantizing must never raise it.
    const rampMax =
      i === 0
        ? v
        : Math.max(
            peakRampAllowance(t.reference, t.allowed, {
              provenWeeklyMeters: opts.provenWeeklyMeters,
            }),
            // The grid-step allowance is only granted once the incoming
            // (pre-quantized) trajectory has itself reached the grid point —
            // this is what turns a clamped smooth ramp into plateau-then-step.
            Math.min(t.reference + rampGridStepFor(t.reference), Math.floor(v / grid) * grid),
          );
    const cap = Math.min(staticCap(i), rampMax);
    let q = Math.round(v / grid) * grid;
    if (q > cap) q = Math.floor(v / grid) * grid;
    if (q > cap) q = Math.floor(cap / quantGridFor(cap)) * quantGridFor(cap);
    if (q <= 0) q = Math.min(v, cap);
    if (
      !isDown &&
      prevBuild != null &&
      prevBuild > 0 &&
      Math.abs(q - prevBuild) < PLATEAU_BAND * prevBuild &&
      // …unless the underlying trajectory has earned a full grid step past the
      // plateau — without this escape a step blocked at a grid boundary (e.g.
      // the next 5 km point sitting past the return-lane cap) flattens forever.
      v - prevBuild < quantGridFor(prevBuild)
    ) {
      // Flattening to an earlier build value is always cap-safe: it is ≤ the
      // running peak and satisfied every static cap at a smaller growth index.
      q = prevBuild;
    }
    out[i] = q;
    // Week 1 measures off an empty peak, so it can never spend the burst.
    t =
      i === 0
        ? { reference: Math.max(t.reference, q), allowed: t.allowed }
        : advanceRamp(t, q, opts.ceiling, opts.burst);
    if (!isDown) prevBuild = q;
  }
  return out;
}

/** Race-distance → taper length. Marathon ~3 wk, half ~2 wk, 10k/shorter ~1 wk. */
export function taperWeekCount(raceDistanceMeters: number | null): number {
  if (raceDistanceMeters == null) return 0;
  if (raceDistanceMeters >= 32_000) return 3; // marathon territory (~3 weeks)
  if (raceDistanceMeters >= 16_000) return 2; // half territory (~2 weeks)
  return 1; // 10k / shorter — final 7–10 days
}

// Taper volume as a fraction of the last build week, by taper length. Encodes
// the classic ~−20/−40/−60% marathon cut, compressed for shorter races.
const TAPER_STAGES: Record<number, number[]> = {
  1: [0.6],
  2: [0.75, 0.55],
  3: [0.8, 0.6, 0.4],
};

/**
 * Shape the final `taperCount` weeks into a staged taper: volumes stepped down
 * off the last build week, phases set to `taper` (final week `race` when
 * race-anchored). Keeps at least one build week when the plan is short. Pure.
 */
export function applyTaper(
  weeks: PlanMacroWeek[],
  taperCount: number,
  raceAnchored: boolean,
): PlanMacroWeek[] {
  const n = weeks.length;
  if (taperCount <= 0 || n === 0) return weeks;
  const count = Math.min(taperCount, n > 1 ? n - 1 : n);
  const stages = TAPER_STAGES[count] ?? TAPER_STAGES[3];
  const buildEnd = n - count; // index of the first taper week
  const base =
    weeks[buildEnd - 1]?.targetDistanceMeters ?? weeks[buildEnd]?.targetDistanceMeters ?? 0;
  return weeks.map((w, i) => {
    if (i < buildEnd) return w;
    const factor = stages[i - buildEnd] ?? stages[stages.length - 1];
    const fromEnd = n - 1 - i;
    const phase = raceAnchored && fromEnd === 0 ? "race" : "taper";
    return { ...w, targetDistanceMeters: Math.round(base * factor), phase };
  });
}

/** Force every target pace to null — the plan stores intent, not paces (D8). */
export function stripPaces(
  structure: WorkoutStructureSet[] | null | undefined,
): WorkoutStructureSet[] | null {
  if (!structure) return null;
  return structure.map((set) => ({
    ...set,
    steps: set.steps.map((step) => ({ ...step, target_pace: null, target_paces: null })),
  }));
}

/** Deterministic per-session distance estimate (meters) from its structure. */
export function estimateStructureDistanceMeters(
  structure: WorkoutStructureSet[] | null | undefined,
): number {
  if (!structure) return 0;
  let meters = 0;
  for (const set of structure) {
    const setReps = set.set_reps ?? 1;
    let inner = 0;
    for (const step of set.steps) {
      const stepReps = step.reps ?? 1;
      const work =
        step.work_type === "DISTANCE" ? step.work_value : step.work_value * EASY_PACE_MPS;
      const rec =
        step.recovery_value == null
          ? 0
          : step.recovery_type === "DISTANCE"
            ? step.recovery_value
            : step.recovery_value * EASY_PACE_MPS;
      inner += stepReps * (work + rec);
    }
    meters += setReps * inner;
  }
  return Math.round(meters);
}

/**
 * Parse the `~X.X km` volume hint the plan-builder appends to a structureless
 * session's description (see `appendDistanceHint`) back into meters. Returns 0
 * when there is no parsable hint.
 */
export function parseDistanceHintMeters(description: string | null | undefined): number {
  if (!description) return 0;
  const m = description.match(/~\s*([\d.]+)\s*km/i);
  if (!m) return 0;
  const km = Number.parseFloat(m[1]);
  return Number.isFinite(km) ? Math.round(km * 1000) : 0;
}

/**
 * A planned session's estimated distance (meters): structure-bearing sessions
 * use the deterministic structure estimator; structureless sessions fall back
 * to the `~X.X km` description hint the plan-builder wrote.
 */
export function estimatePlannedSessionDistanceMeters(
  structure: WorkoutStructureSet[] | null | undefined,
  description: string | null | undefined,
): number {
  if (structure && structure.length > 0) return estimateStructureDistanceMeters(structure);
  return parseDistanceHintMeters(description);
}

function repairPhases(weeks: PlanMacroWeek[], raceAnchored: boolean): PlanMacroWeek[] {
  const n = weeks.length;
  return weeks.map((w, i) => {
    const fromEnd = n - 1 - i; // 0 = final week
    let phase = w.phase;
    if (!raceAnchored) {
      if (phase === "race") phase = "peak";
      if (phase === "taper") phase = "build";
    } else {
      if (phase === "race" && fromEnd !== 0) phase = "build";
      if (phase === "taper" && fromEnd > 1) phase = "build";
    }
    return { ...w, phase };
  });
}

/**
 * Real-athlete context the macro guards shape against. The node passes these in
 * explicitly (guards never read graph state) so every guard stays pure/testable.
 */
export type MacroShapingParams = {
  baselineWeeklyMeters: number | null;
  longestRunMeters: number | null;
  /** Max trailing-4-week average over the last ~6 months (see gather_context) — the comeback anchor. */
  provenWeeklyMeters: number | null;
  /** Longest single run in the same ~6-month window. */
  provenLongestRunMeters: number | null;
  volumeAggressiveness: VolumeAggressiveness;
  maxWeeklyVolumeMeters: number | null;
  raceDistanceMeters: number | null;
};

/**
 * Rebuild the macro's weeks against the authoritative Monday-aligned week grid:
 * week count/index/startDate come from the input range (never trusted from the
 * LLM); phases are constrained to the taper/race-near-the-end rule. Weekly
 * volumes are then shaped, in order: anchor week 1 to the real baseline → carry
 * missing targets forward → clamp the week-over-week ramp to the aggressiveness
 * ceiling → cap implied long-run spikes → hard-cap to the user's max → insert
 * recovery weeks → taper the tail → re-clamp the ramp against the running peak →
 * hard-cap again. The guarantees are asserted on the FINAL array, not per stage.
 */
export type MacroShapingResult = { macro: PlanMacro; notices: PlanNotice[] };

function fmtKm(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * First week a shaping stage lowered by more than a rounding artefact. The 1%
 * band keeps `Math.round` noise from being reported to the athlete as a refusal.
 */
function firstReduced(before: number[], after: number[]): number {
  for (let i = 0; i < after.length; i++) {
    if (after[i] < before[i] * 0.99) return i;
  }
  return -1;
}

// LLM wording that claims a week is a cutback: recovery vocabulary or a bare
// negative percentage ("-20%", "~-20%"). Only ever tested against weeks whose
// final volume did not drop, where any such claim is false by construction.
const RECOVERY_NOTE_PATTERN = /recovery|cutback|down week|deload|~?\s*[-−]\s*\d+(\.\d+)?\s*%/i;

/**
 * Shape the macro and collect the notices the review gate owes the athlete.
 * The volume ceilings here are injury guards and stay deliberately
 * un-patchable by feedback ("add more mileage" past the ramp is refused) —
 * but every refusal that actually bit is reported, with the reason, instead
 * of vanishing. Coaching-shape reductions (down weeks, taper) are NOT
 * notices: they are the plan working as intended, not a request being denied.
 */
export function shapeMacro(
  raw: PlanMacro,
  input: PlanBuilderInput,
  params: MacroShapingParams,
): MacroShapingResult {
  const starts = expectedWeekStarts(input.startDate, input.endDate);
  const raceAnchored = input.raceEventId != null;

  const weeks: PlanMacroWeek[] = starts.map((startDate, i) => {
    const src = raw.weeks[i];
    return {
      weekIndex: i + 1,
      startDate,
      phase: src?.phase ?? "base",
      targetDistanceMeters: Math.max(0, Math.round(src?.targetDistanceMeters ?? 0)),
      notes: src?.notes ?? null,
      keySessions: src?.keySessions ?? [],
    };
  });

  const phased = repairPhases(weeks, raceAnchored);

  const taperCount = raceAnchored ? taperWeekCount(params.raceDistanceMeters) : 0;
  const buildWeeks = Math.max(0, phased.length - taperCount);
  const ramp = VOLUME_RAMP[params.volumeAggressiveness];

  const notices: PlanNotice[] = [];
  const requested = phased.map((w) => w.targetDistanceMeters);
  const anchored = anchorWeekOne(requested, params.baselineWeeklyMeters);
  const floored = floorWeeklyTargets(anchored);
  const ramped = clampWeeklyRamp(floored, ramp.ceiling, ramp.burst, params.provenWeeklyMeters);
  const longCapped = capLongestRunSpike(
    ramped,
    params.longestRunMeters,
    params.provenLongestRunMeters,
  );
  // Hard-cap BEFORE the taper so the taper's staged fractions come off an
  // already-capped build week and stay strictly decreasing (capping afterwards
  // flattens the first taper weeks onto the same ceiling value).
  const maxCapped = capMaxWeekly(longCapped, params.maxWeeklyVolumeMeters);
  const targets = enforceDownWeeks(maxCapped, buildWeeks);

  const rampIdx = firstReduced(floored, ramped);
  const longIdx = firstReduced(ramped, longCapped);
  const maxIdx = firstReduced(longCapped, maxCapped);

  // Plateau-and-step quantization over the build region, BEFORE the taper so
  // the taper's staged fractions come off the quantized (emitted) last build
  // week and stay strictly below it — staging off pre-quantization values let
  // a race week land above a rounded-down build region.
  const downWeekIndices = downWeekIndicesFor(buildWeeks, targets.length);
  const quantizedTargets = quantizeWeeklyTargets(targets, {
    ceiling: ramp.ceiling,
    burst: ramp.burst,
    provenWeeklyMeters: params.provenWeeklyMeters,
    maxWeeklyVolumeMeters: params.maxWeeklyVolumeMeters,
    longestRunMeters: params.longestRunMeters,
    provenLongestRunMeters: params.provenLongestRunMeters,
    downWeekIndices,
    taperStartIndex: buildWeeks,
  });

  let shaped: PlanMacroWeek[] = phased.map((w, i) => ({
    ...w,
    targetDistanceMeters: quantizedTargets[i],
  }));
  if (taperCount > 0) shaped = applyTaper(shaped, taperCount, raceAnchored);
  const quantized = shaped.map((w) => w.targetDistanceMeters);

  // Final passes: every stage above can lower a week, so the ramp invariant is
  // re-established on the finished array (see `clampRampAgainstPeak`), then the
  // user's hard ceiling is re-applied. Both only ever lower a week, so neither
  // can reopen the long-run spike cap.
  const capped = capMaxWeekly(
    clampRampAgainstPeak(quantized, ramp.ceiling, ramp.burst, {
      provenWeeklyMeters: params.provenWeeklyMeters,
      gridStep: true,
    }),
    params.maxWeeklyVolumeMeters,
  );

  // Each rule is DETECTED at its own stage (that is what names the refusal),
  // but the notice quotes the FINAL capped value: an intermediate number (pre
  // down-weeks/taper) is one the athlete never sees in the printed plan.
  if (requested[0] > 0 && anchored[0] < requested[0] * 0.99) {
    notices.push({
      kind: "clamped",
      code: "baseline_anchor",
      message: `Week 1 starts at ${fmtKm(capped[0])} instead of ${fmtKm(requested[0])}: the plan anchors your first week to what you are actually running now, not to the goal. Starting above your real baseline is the top cause of injury.`,
      observed: requested[0],
      limit: capped[0],
      weekIndex: 1,
    });
  }

  if (rampIdx >= 0) {
    notices.push({
      kind: "clamped",
      code: "weekly_ramp_exceeded",
      message: `Week ${rampIdx + 1} was cut from ${fmtKm(floored[rampIdx])} to ${fmtKm(capped[rampIdx])}: your ${params.volumeAggressiveness} build-up allows about +${Math.round(ramp.ceiling * 100)}% a week. Ramping faster is the top cause of running injury, so this ceiling is not negotiable — pick a more aggressive build-up or a longer plan to get there safely.`,
      observed: floored[rampIdx],
      limit: capped[rampIdx],
      weekIndex: rampIdx + 1,
    });
  }

  if (longIdx >= 0) {
    notices.push({
      kind: "clamped",
      code: "long_run_spike",
      message: `Week ${longIdx + 1} was cut from ${fmtKm(ramped[longIdx])} to ${fmtKm(capped[longIdx])}: that volume implies a long run well beyond your recent longest of ${fmtKm(params.longestRunMeters ?? 0)}. A sudden long-run jump is a stronger injury signal than weekly volume.`,
      observed: ramped[longIdx],
      limit: capped[longIdx],
      weekIndex: longIdx + 1,
    });
  }

  if (maxIdx >= 0) {
    notices.push({
      kind: "clamped",
      code: "max_weekly_volume_exceeded",
      message: `Week ${maxIdx + 1} was capped at ${fmtKm(capped[maxIdx])} by your own ${fmtKm(params.maxWeeklyVolumeMeters ?? 0)} weekly ceiling. Raise the ceiling if you want more.`,
      observed: longCapped[maxIdx],
      limit: capped[maxIdx],
      weekIndex: maxIdx + 1,
    });
  }

  // The LLM wrote each week's notes against its own proposed volume; once the
  // shaping stages move a week by more than this, the prose ("recovery week,
  // ~18% drop") contradicts the stored number — drop it rather than lie.
  const NOTES_DRIFT_TOLERANCE = 0.15;
  const drifted = shaped.map((w, i) => {
    const req = requested[i];
    const invalidated =
      req >= MIN_PLAUSIBLE_WEEKLY_METERS && Math.abs(capped[i] - req) > req * NOTES_DRIFT_TOLERANCE;
    return { ...w, targetDistanceMeters: capped[i], notes: invalidated ? null : w.notes };
  });

  // Recovery labelling is deterministic: the guards decide where the cutback
  // weeks are, so a real dip (≥10% below the prior week, taper/race excluded)
  // gets a note computed from the final numbers — replacing whatever the LLM
  // wrote — and a week that does NOT drop can never claim to be one.
  const final = drifted.map((w, i) => {
    const prev = i > 0 ? capped[i - 1] : null;
    const tail = w.phase === "taper" || w.phase === "race";
    if (!tail && prev != null && prev > 0 && capped[i] <= prev * 0.9) {
      const drop = Math.round((1 - capped[i] / prev) * 100);
      return { ...w, notes: `Recovery week (−${drop}%).` };
    }
    if ((prev == null || capped[i] >= prev) && w.notes && RECOVERY_NOTE_PATTERN.test(w.notes)) {
      return { ...w, notes: null };
    }
    return w;
  });

  // Measured against the quantized array, not the pre-quantization one: a week
  // the grid merely rounded down is coaching shape, not a refusal.
  if (rampIdx < 0) {
    const peakIdx = firstReduced(quantized, capped);
    if (peakIdx >= 0) {
      notices.push({
        kind: "clamped",
        code: "weekly_ramp_exceeded",
        message: `Week ${peakIdx + 1} was held to ${fmtKm(capped[peakIdx])}: no week may climb more than about +${Math.round(ramp.ceiling * 100)}% above the highest week before it, even coming out of a recovery week.`,
        observed: quantized[peakIdx],
        limit: capped[peakIdx],
        weekIndex: peakIdx + 1,
      });
    }
  }

  return { macro: { name: raw.name, rationale: raw.rationale, weeks: final }, notices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-level guards (the polarization / day-placement / injury layer).
// Pure functions over one week's proposed sessions; the node passes settings in.
// Research-backed constants, tunable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a session as "hard" (quality) for the ≥80% easy / ≤20% hard
 * polarization rule. Hard = TEMPO / interval types / PROGRESSIVE_LONG (its fast
 * segment) — i.e. every `INTERVAL_TRAINING_TYPES` value. Defensive fallback: a
 * session carrying an explicit structure that is not an easy/long/race type is
 * treated as quality even if mislabeled. EASY/RECOVERY/LONG/RACE are not hard.
 */
export function isHardSession(
  sessionType: TrainingType,
  structure: WorkoutStructureSet[] | null | undefined,
): boolean {
  if ((INTERVAL_TRAINING_TYPES as readonly TrainingType[]).includes(sessionType)) return true;
  const bucket = trainingBucketFor(sessionType);
  return (
    (structure?.length ?? 0) > 0 && bucket !== "EASY" && bucket !== "LONG" && bucket !== "RACE"
  );
}

// Quality (hard) sessions per week by phase at intensity = balanced. Polarized
// training (Seiler): base is nearly all easy, quality ramps through build/peak,
// then drops in the taper/race week. Race week keeps 1 (the race itself is it).
export const QUALITY_SESSIONS_BY_PHASE: Record<PlanWeekPhase, number> = {
  base: 0,
  build: 2,
  peak: 3,
  taper: 1,
  race: 1,
};

/**
 * Max hard sessions for a week: the per-phase baseline shifted by the intensity
 * dial (`comfortable` −1, floor 0; `challenging` +1). Overall cap 3, except peak
 * may reach 4 at `challenging`.
 */
export function qualityCap(phase: PlanWeekPhase, intensity: IntensityAggressiveness): number {
  const shift = intensity === "comfortable" ? -1 : intensity === "challenging" ? 1 : 0;
  const ceiling = phase === "peak" ? 4 : 3;
  return Math.max(0, Math.min(ceiling, QUALITY_SESSIONS_BY_PHASE[phase] + shift));
}

function downgradeToEasy(s: GeneratedSession): GeneratedSession {
  return { ...s, sessionType: "EASY", structure: null, title: "Easy run", description: null };
}

const isLongBucket = (s: GeneratedSession) => trainingBucketFor(s.sessionType) === "LONG";

/**
 * Strip the *quality* out of a long run while keeping the long run: a
 * PROGRESSIVE_LONG demoted for the quality cap or for adjacency becomes a plain
 * LONG (which `isHardSession` does not count), not an EASY run. The week's long
 * run is its aerobic anchor and the one session an athlete plans their week
 * around — losing it is a worse outcome than losing its fast finish. Anything
 * that is not a long run still demotes to EASY.
 */
function demoteHardSession(s: GeneratedSession): GeneratedSession {
  if (!isLongBucket(s)) return downgradeToEasy(s);
  return { ...s, sessionType: "LONG", structure: null, title: "Long run", description: null };
}

/**
 * Enforce the polarization cap: keep at most `qualityCap` hard sessions,
 * demoting any excess. Slots go to the long run first and then to the earliest
 * remaining hard sessions — a PROGRESSIVE_LONG is usually the week's last
 * session, and an unqualified earliest-first rule sacrifices it to the cap
 * first. Never fabricates hard work when there are too few — the cap is a
 * ceiling.
 */
export function enforceQualityCount(
  sessions: GeneratedSession[],
  phase: PlanWeekPhase,
  intensity: IntensityAggressiveness,
): GeneratedSession[] {
  const cap = qualityCap(phase, intensity);
  const out = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  const longIdx = out.findIndex(
    (s) => isLongBucket(s) && isHardSession(s.sessionType, s.structure),
  );
  const reserved = longIdx >= 0 && cap > 0 ? 1 : 0;
  let kept = 0;
  return out.map((s, i) => {
    if (!isHardSession(s.sessionType, s.structure)) return s;
    if (i === longIdx) return cap > 0 ? s : demoteHardSession(s);
    kept += 1;
    return kept > cap - reserved ? demoteHardSession(s) : s;
  });
}

/**
 * Space hard sessions so no two land on consecutive calendar days: when a hard
 * session sits within 1 day of the previous hard one, swap one of them with an
 * easy session on a day that clears every other hard session.
 *
 * `pinnedDate` is the long run's slot once `placeLongRun` has claimed it. The
 * session sitting there is immovable — neither as the session being spaced nor
 * as an easy swap *partner*, since a plain LONG is not "hard" and would
 * otherwise be swapped off the preferred day as if it were filler. When the
 * later of an adjacent pair is pinned we move the earlier one instead, which is
 * what makes the Saturday-group-run + Sunday-long-run week resolvable at all.
 *
 * Best-effort — a no-op when nothing is swappable; `downgradeAdjacentHardSessions`
 * is the backstop. Bounded by `guard` since swaps may now move either direction.
 */
export function spaceHardSessions(
  sessions: GeneratedSession[],
  pinnedDate?: string | null,
): GeneratedSession[] {
  const s = sessions.map((x) => ({ ...x })).sort((a, b) => a.date.localeCompare(b.date));
  const hard = (x: GeneratedSession) => isHardSession(x.sessionType, x.structure);
  const movable = (x: GeneratedSession) => pinnedDate == null || x.date !== pinnedDate;
  // Would moving s[idx] onto `date` clear every *other* hard session?
  const clears = (idx: number, date: string) =>
    s.every((o, k) => k === idx || !hard(o) || daysBetweenISO(o.date, date) > 1);

  for (let guard = 0, i = 1; i < s.length && guard < 64; i++) {
    if (!hard(s[i])) continue;
    let prev = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (hard(s[k])) {
        prev = k;
        break;
      }
    }
    if (prev < 0 || daysBetweenISO(s[prev].date, s[i].date) > 1) continue;

    let swapped = false;
    for (const m of movable(s[i]) ? [i, prev] : [prev]) {
      if (!movable(s[m])) continue;
      // Nearest clearing day first, so a session moves as little as the rule allows.
      const candidates = s
        .map((_, j) => j)
        .filter((j) => j !== m && !hard(s[j]) && movable(s[j]) && clears(m, s[j].date))
        .sort(
          (a, b) => daysBetweenISO(s[a].date, s[m].date) - daysBetweenISO(s[b].date, s[m].date),
        );
      if (candidates.length > 0) {
        const j = candidates[0];
        const tmp = s[m].date;
        s[m].date = s[j].date;
        s[j].date = tmp;
        swapped = true;
      }
      if (swapped) break;
    }
    if (swapped) {
      s.sort((a, b) => a.date.localeCompare(b.date));
      guard += 1;
      i = 0; // restart: dates shifted
    }
  }
  return s;
}

/**
 * Guarantee the "never two hard days back-to-back" rule that `spaceHardSessions`
 * can only best-effort: when the week has no swappable easy day (e.g. 3 quality
 * sessions on a 3-run-day week), re-dating cannot separate them, so one of the
 * pair is demoted instead. The long run is never the session sacrificed while
 * the other one can go — and when it is the only candidate it demotes to a plain
 * LONG, so the week still has its long run. Run last, after all date shuffling.
 */
export function downgradeAdjacentHardSessions(sessions: GeneratedSession[]): GeneratedSession[] {
  const out = [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((x) => ({ ...x }) as GeneratedSession);
  const hard = (x: GeneratedSession) => isHardSession(x.sessionType, x.structure);
  let lastHardIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (!hard(out[i])) continue;
    if (lastHardIdx >= 0 && daysBetweenISO(out[lastHardIdx].date, out[i].date) <= 1) {
      const victim = isLongBucket(out[i]) && !isLongBucket(out[lastHardIdx]) ? lastHardIdx : i;
      out[victim] = demoteHardSession(out[victim]);
      if (victim === lastHardIdx) lastHardIdx = i;
      continue;
    }
    lastHardIdx = i;
  }
  return out;
}

// Number of run days per week when the athlete gives no explicit preference.
export const DEFAULT_DAYS_PER_WEEK = 5;

/** Resolve the week's run-day count: explicit request, else observed average, else default. Clamped 1–7. */
export function resolveDaysPerWeek(
  explicit: number | null | undefined,
  observedAvgRunDays: number | null,
): number {
  const raw =
    explicit ??
    (observedAvgRunDays != null && observedAvgRunDays > 0
      ? Math.round(observedAvgRunDays)
      : DEFAULT_DAYS_PER_WEEK);
  return Math.min(7, Math.max(1, raw));
}

/**
 * Cap the week at `daysPerWeek` run days (the rest are rest days). Sessions are
 * dropped latest-first in three tiers, so the long run is the last thing to go:
 * easy/recovery fill runs, then quality sessions, then long runs. At
 * `daysPerWeek: 1` that leaves the long run standing, which is the right single
 * run for a week. Never adds sessions (too-few is handled by the volume-fill
 * logic).
 */
export function enforceDaysPerWeek(
  sessions: GeneratedSession[],
  daysPerWeek: number,
): GeneratedSession[] {
  const cap = Math.min(7, Math.max(1, daysPerWeek));
  if (sessions.length <= cap) return [...sessions];
  const s = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  const keep = s.map(() => true);
  let excess = s.length - cap;
  const tier = (x: GeneratedSession) =>
    isLongBucket(x) ? 2 : isHardSession(x.sessionType, x.structure) ? 1 : 0;
  for (const t of [0, 1, 2]) {
    for (let i = s.length - 1; i >= 0 && excess > 0; i--) {
      if (keep[i] && tier(s[i]) === t) {
        keep[i] = false;
        excess -= 1;
      }
    }
  }
  return s.filter((_, i) => keep[i]);
}

// Preferred long-run weekday, expressed as a Monday-aligned week offset
// (0 = Monday … 6 = Sunday), matching the plan's Monday-aligned week grid.
// Default Sunday — the classic long-run slot at the end of the training week.
export const DEFAULT_LONG_RUN_OFFSET = 6;

/** Clamp a `preferredLongRunDay` (0=Mon … 6=Sun) into a valid week offset. */
export function longRunOffset(preferredLongRunDay: number | null | undefined): number {
  return Math.min(6, Math.max(0, preferredLongRunDay ?? DEFAULT_LONG_RUN_OFFSET));
}

/**
 * Move the week's long-bucket session (LONG / PROGRESSIVE_LONG) onto the
 * preferred long-run day, swapping dates with whatever already occupied that day
 * so the week does not end up with two sessions stacked on one date.
 */
export function placeLongRun(
  sessions: GeneratedSession[],
  weekStart: string,
  preferredLongRunDay: number | null | undefined,
): GeneratedSession[] {
  const target = addDaysISO(weekStart, longRunOffset(preferredLongRunDay));
  const s = sessions.map((x) => ({ ...x }));
  const idx = s.findIndex((x) => trainingBucketFor(x.sessionType) === "LONG");
  if (idx >= 0) {
    const occupant = s.findIndex((x, i) => i !== idx && x.date === target);
    if (occupant >= 0) s[occupant].date = s[idx].date;
    s[idx].date = target;
  }
  return s.sort((a, b) => a.date.localeCompare(b.date));
}

/** The date the week's long run occupies, if it has one. */
function longRunDate(sessions: GeneratedSession[]): string | null {
  return sessions.find(isLongBucket)?.date ?? null;
}

// A cross-training session is represented as a plain `OTHER` run-type with no
// structure — the schema has no dedicated cross-training value (OTHER is the
// catch-all). The app renders OTHER; the title/description carry the intent.
export const CROSS_TRAINING_TITLE = "Cross-training (elliptical / spinning)";
export const CROSS_TRAINING_INJURY_DESCRIPTION =
  "Elliptical or spinning (indoor bike) substitute for an easy run to protect the active injury — same duration/load.";
export const CROSS_TRAINING_REQUEST_DESCRIPTION =
  "Low-impact aerobic session — elliptical or spinning, easy effort.";
export const MAX_CROSS_TRAINING_PER_WEEK = 2;

// The LLM sometimes emits its own cross-training days from the prose — those
// count against the resolved total, or the week ends up with more
// cross-training than the athlete's setting.
const CROSS_TRAINING_HINT =
  /cross[\s-]?train|elliptical|spin(?:ning)?\b|indoor bike|cycling|swim|aqua[\s-]?jog|low[\s-]?impact/i;

export function isCrossTrainingSession(s: GeneratedSession): boolean {
  return (
    s.sessionType === "OTHER" &&
    (!s.structure || s.structure.length === 0) &&
    CROSS_TRAINING_HINT.test(`${s.title} ${s.description ?? ""}`)
  );
}

function toCrossTraining(s: GeneratedSession, injuryDriven: boolean): GeneratedSession {
  return {
    ...s,
    sessionType: "OTHER",
    structure: null,
    title: CROSS_TRAINING_TITLE,
    description: injuryDriven
      ? CROSS_TRAINING_INJURY_DESCRIPTION
      : CROSS_TRAINING_REQUEST_DESCRIPTION,
  };
}

/**
 * Hold the week to exactly `count` (capped 0–2) cross-training sessions.
 * LLM-emitted cross days count first; any beyond the count demote to easy runs
 * (day counts stay intact). The shortfall converts EASY/RECOVERY runs 1:1 —
 * protecting an injury or honouring the athlete's request while preserving
 * easy volume. Never touches a LONG or quality session, and only converts in
 * weeks with ≥2 easy runs to spare. `injuryDriven` picks the description: the
 * injury wording only when the count comes from an active injury.
 */
export function substituteCrossTraining(
  sessions: GeneratedSession[],
  count: number,
  injuryDriven: boolean,
): GeneratedSession[] {
  const want = Math.min(MAX_CROSS_TRAINING_PER_WEEK, Math.max(0, count));
  const existing = sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => isCrossTrainingSession(s))
    .map(({ i }) => i);
  const demote = new Set(existing.slice(want));
  const missing = want - Math.min(existing.length, want);
  let convert = new Set<number>();
  if (missing > 0) {
    const easyIdx = sessions
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          (s.sessionType === "EASY" || s.sessionType === "RECOVERY") &&
          !isHardSession(s.sessionType, s.structure),
      )
      .map(({ i }) => i);
    if (easyIdx.length >= 2) convert = new Set(easyIdx.slice(0, missing));
  }
  if (demote.size === 0 && convert.size === 0) return sessions;
  return sessions.map((s, i) =>
    demote.has(i) ? downgradeToEasy(s) : convert.has(i) ? toCrossTraining(s, injuryDriven) : s,
  );
}

/**
 * Post-condition before a generated plan is shown or persisted: a plan with no
 * sessions at all, or with any single week left empty, is a FAILED generation —
 * almost always a null/unparsable LLM response that the `?? []` fallbacks
 * quietly turned into an empty week. Persisting it produces an `active` plan
 * containing nothing, reported to the client as a successful `done` with a
 * planId. Throw instead so the SSE stream emits `error` and nothing is written.
 */
export function assertPlanHasSessions(
  weeks: { weekIndex: number }[],
  sessionsByWeek: { weekIndex: number; sessions: unknown[] }[],
): void {
  const empty = weeks.filter(
    (w) => (sessionsByWeek.find((s) => s.weekIndex === w.weekIndex)?.sessions.length ?? 0) === 0,
  );
  if (empty.length === 0) return;
  throw new AppError(
    502,
    `Plan generation produced no sessions for week(s) ${empty.map((w) => w.weekIndex).join(", ")}`,
  );
}

/** Everything the session guards need beyond the macro week itself. */
export type SessionGuardParams = {
  intensityAggressiveness: IntensityAggressiveness;
  daysPerWeek: number;
  preferredLongRunDay: number | null;
  crossTrainingCount: number;
  crossTrainingInjuryDriven: boolean;
  raceDistanceMeters: number | null;
  /** Proven 6-month capacity (see `AthleteBaselineVolume`) — gates the short-run consolidation. */
  provenWeeklyMeters: number | null;
};

// A long run beyond ~40% of the week's volume is an outsized injury risk —
// same family as `capLongestRunSpike`'s 35% implied-share assumption. Applied
// to the volume FILL: with few unstructured sessions the even split otherwise
// dumps nearly the whole weekly target onto the long run.
export const LONG_RUN_MAX_FILL_SHARE = 0.4;

// Weighted volume-fill: the long run carries this weight against 1 for every
// other fill run, so it is actually the week's longest run instead of an
// even-split clone of the easies.
export const LONG_RUN_FILL_WEIGHT = 2.5;

// A recovery jog is deliberately the week's shortest run.
export const RECOVERY_FILL_WEIGHT = 0.6;

// For an experienced, uninjured athlete a run under 5 km is pointless filler:
// the week plans FEWER sessions instead (rest day), and the count builds back
// as volume grows. Beginners (no proven history) and injured athletes are
// exempt — run-walks and short cross-training-adjacent easies stay legal.
export const MIN_FILL_RUN_METERS = 5_000;
export const EXPERIENCED_PROVEN_WEEKLY_METERS = 15_000;

function appendDistanceHint(description: string | null | undefined, meters: number): string {
  const hint = `~${(meters / 1000).toFixed(1)} km`;
  return description ? `${description} — ${hint}` : hint;
}

export type WeekAssemblyResult = { sessions: GeneratedSession[]; notices: PlanNotice[] };

/**
 * Deterministically finalize one week's sessions. Order: repair dates into the
 * week + null every pace → cap at 7/week → enforce the polarization quality cap
 * (demote excess hard runs) → cap to the athlete's run-day count → pin the long
 * run to the preferred day → space the remaining hard sessions off consecutive
 * days around it → demote any hard session spacing could not separate →
 * substitute easy runs with cross-training around an active injury → distribute
 * the remaining volume budget across the structureless fill runs (cross-training
 * sessions have null structure, so pace-nulling and this fill both apply to them
 * unchanged). All shaping steps are pure; the node passes settings in `params`.
 *
 * Notices report the refusals worth telling the athlete about. Only the two
 * that deny an explicit "give me more hard work" request are reported — the
 * polarization cap and the no-two-hard-days-in-a-row rule. Day-count and
 * long-run placement are driven by the athlete's own (now feedback-patchable)
 * settings, so trimming to them is not a refusal.
 */
export function assembleWeekSessionsWithNotices(
  week: PlanMacroWeek,
  raw: GeneratedSession[],
  params: SessionGuardParams,
): WeekAssemblyResult {
  const notices: PlanNotice[] = [];
  const cap = qualityCap(week.phase, params.intensityAggressiveness);
  const requestedHard = raw.filter((s) => isHardSession(s.sessionType, s.structure)).length;
  if (requestedHard > cap) {
    notices.push({
      kind: "clamped",
      code: "quality_sessions_exceeded",
      message: `Week ${week.weekIndex} keeps ${cap} quality session${cap === 1 ? "" : "s"} instead of ${requestedHard}: a ${week.phase} week at ${params.intensityAggressiveness} intensity supports ${cap}, and polarized training wants at least 80% of running easy. Raise the intensity setting, or ask again in a build week, to get more.`,
      observed: requestedHard,
      limit: cap,
      weekIndex: week.weekIndex,
    });
  }

  let sessions: GeneratedSession[] = raw.map((s) => ({
    ...s,
    date: repairSessionDate(s.date, week.startDate),
    description: s.description ?? null,
    structure: stripPaces(s.structure ?? null),
  }));

  sessions.sort((a, b) => a.date.localeCompare(b.date));
  if (sessions.length > MAX_SESSIONS_PER_WEEK) {
    sessions = sessions.slice(0, MAX_SESSIONS_PER_WEEK);
  }

  sessions = enforceQualityCount(sessions, week.phase, params.intensityAggressiveness);
  sessions = enforceDaysPerWeek(sessions, params.daysPerWeek);
  // Pin the long run FIRST, then space the rest around it: the pinned day is
  // immovable, so spacing re-dates the *other* session of an adjacent pair —
  // what makes the Saturday-group-run + Sunday-long-run week resolvable.
  sessions = placeLongRun(sessions, week.startDate, params.preferredLongRunDay);
  sessions = spaceHardSessions(sessions, longRunDate(sessions));
  const hardBeforeSpacing = sessions.filter((s) =>
    isHardSession(s.sessionType, s.structure),
  ).length;
  sessions = downgradeAdjacentHardSessions(sessions);
  const hardAfterSpacing = sessions.filter((s) => isHardSession(s.sessionType, s.structure)).length;
  if (hardAfterSpacing < hardBeforeSpacing) {
    notices.push({
      kind: "clamped",
      code: "hard_sessions_adjacent",
      message: `Week ${week.weekIndex} drops ${hardBeforeSpacing - hardAfterSpacing} quality session${hardBeforeSpacing - hardAfterSpacing === 1 ? "" : "s"} to an easier run: with ${params.daysPerWeek} run days there was no free day left to separate them, once the long run was placed on your preferred day. More run days would make room.`,
      observed: hardBeforeSpacing,
      limit: hardAfterSpacing,
      weekIndex: week.weekIndex,
    });
  }
  sessions = substituteCrossTraining(
    sessions,
    params.crossTrainingCount,
    params.crossTrainingInjuryDriven,
  );
  sessions.sort((a, b) => a.date.localeCompare(b.date));

  const structuredMeters = sessions.reduce(
    (n, s) => n + estimateStructureDistanceMeters(s.structure),
    0,
  );
  const unstructured = sessions.filter((s) => !s.structure || s.structure.length === 0);
  // Race day is pinned at the race distance, never a fill slot — and it
  // consumes budget before the split so race-week easies stay small.
  const races = unstructured.filter((s) => s.sessionType === "RACE");
  let raceMeters = 0;
  if (params.raceDistanceMeters != null && params.raceDistanceMeters > 0) {
    raceMeters = races.length * params.raceDistanceMeters;
    for (const s of races) {
      s.description = appendDistanceHint(s.description, params.raceDistanceMeters);
    }
  }
  const fill = unstructured.filter((s) => s.sessionType !== "RACE");
  if (fill.length > 0) {
    const budget = Math.max(0, week.targetDistanceMeters - structuredMeters - raceMeters);
    const longMax = Math.round(week.targetDistanceMeters * LONG_RUN_MAX_FILL_SHARE);
    const fillWeight = (s: GeneratedSession) =>
      s.sessionType === "RECOVERY" ? RECOVERY_FILL_WEIGHT : 1;

    type FillSplit = {
      longFill: GeneratedSession | undefined;
      longShare: number;
      longMeters: number;
      others: { s: GeneratedSession; share: number; meters: number }[];
    };
    const computeSplit = (fillRuns: GeneratedSession[], sessionCount: number): FillSplit => {
      const longFill = sessionCount >= 2 ? fillRuns.find(isLongBucket) : undefined;
      const others = fillRuns.filter((s) => s !== longFill);
      const othersWeight = others.reduce((n, s) => n + fillWeight(s), 0);
      const totalWeight = othersWeight + (longFill ? LONG_RUN_FILL_WEIGHT : 0);
      const longShare = longFill ? Math.round((budget * LONG_RUN_FILL_WEIGHT) / totalWeight) : 0;
      const longMeters = Math.min(longShare, longMax);
      const perWeightUnit = othersWeight > 0 ? (budget - longMeters) / othersWeight : 0;
      return {
        longFill,
        longShare,
        longMeters,
        // No easy fill run may out-distance the week's (possibly capped) long
        // run — an oversized "easy" run would dodge the long-run cap by not
        // being typed LONG. Capped excess is dropped, not reassigned.
        others: others.map((s) => {
          const share = Math.round(perWeightUnit * fillWeight(s));
          return { s, share, meters: longFill ? Math.min(share, longMeters) : share };
        }),
      };
    };

    let remaining = fill;
    let split = computeSplit(remaining, sessions.length);

    // Short-run consolidation: an experienced, uninjured athlete never gets
    // sub-5 km filler — the shortest non-long fill run becomes a rest day and
    // the week re-splits, until every run is meaningful or only the long run
    // remains (see MIN_FILL_RUN_METERS).
    const experienced =
      params.provenWeeklyMeters != null &&
      params.provenWeeklyMeters >= EXPERIENCED_PROVEN_WEEKLY_METERS &&
      !params.crossTrainingInjuryDriven &&
      params.crossTrainingCount === 0;
    if (experienced) {
      const tooShort = (s: FillSplit) =>
        s.others.some((o) => o.meters < MIN_FILL_RUN_METERS) ||
        (s.longFill != null && s.others.length > 0 && s.longMeters < MIN_FILL_RUN_METERS);
      while (split.others.length > (split.longFill ? 0 : 1) && tooShort(split)) {
        const victim = split.others.reduce((min, o) =>
          o.meters < min.meters || (o.meters === min.meters && o.s.date > min.s.date) ? o : min,
        );
        remaining = remaining.filter((s) => s !== victim.s);
        sessions = sessions.filter((s) => s !== victim.s);
        split = computeSplit(remaining, sessions.length);
      }
      const droppedCount = fill.length - remaining.length;
      if (droppedCount > 0) {
        notices.push({
          kind: "clamped",
          code: "short_runs_consolidated",
          message: `Week ${week.weekIndex} plans ${sessions.length} run${sessions.length === 1 ? "" : "s"} instead of ${sessions.length + droppedCount} so every run is a meaningful distance — short filler runs help nobody; the count builds back up as volume grows.`,
          observed: sessions.length + droppedCount,
          limit: sessions.length,
          weekIndex: week.weekIndex,
        });
      }
    }

    if (split.longFill) {
      split.longFill.description = appendDistanceHint(split.longFill.description, split.longMeters);
      if (split.longShare > longMax) {
        // Excess with no other fill run to absorb it is simply not planned;
        // planned < target is the honest outcome.
        notices.push({
          kind: "clamped",
          code: "long_run_share_capped",
          message: `Week ${week.weekIndex}'s long run was held to ${fmtKm(longMax)} instead of ${fmtKm(split.longShare)}: a single long run beyond ${Math.round(LONG_RUN_MAX_FILL_SHARE * 100)}% of the week's volume is an outsized injury risk. The remaining distance ${split.others.length > 0 ? "moves to the week's other runs" : "is left unplanned"}.`,
          observed: split.longShare,
          limit: longMax,
          weekIndex: week.weekIndex,
        });
      }
    }
    let cappedFrom = 0;
    let cappedTo = 0;
    for (const o of split.others) {
      if (split.longFill && o.share > split.longMeters && o.share > cappedFrom) {
        cappedFrom = o.share;
        cappedTo = o.meters;
      }
      o.s.description = appendDistanceHint(o.s.description, o.meters);
    }
    if (cappedFrom > 0) {
      notices.push({
        kind: "clamped",
        code: "fill_run_capped",
        message: `Week ${week.weekIndex}'s easy runs were held to ${fmtKm(cappedTo)} so no easy run exceeds the long run; the remaining distance is left unplanned rather than overloading a single easy day.`,
        observed: cappedFrom,
        limit: cappedTo,
        weekIndex: week.weekIndex,
      });
    }
  }

  return { sessions, notices };
}
