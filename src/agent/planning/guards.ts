import type { WorkoutStructureSet } from "../../schemas/agent_schemas";
import type { GeneratedSession, PlanMacro, PlanMacroWeek } from "./plan_builder_schemas";
import type { PlanBuilderInput, VolumeAggressiveness } from "./plan_builder_state";

// ~2.78 m/s — 5 km in 30 min. Used to approximate distance for TIME-based work
// so a week's estimated volume is comparable regardless of how a step is typed.
export const EASY_PACE_MPS = 5000 / 1800;

const MAX_SESSIONS_PER_WEEK = 7;
const MAX_WEEKLY_RAMP = 1.2;

function parseUTC(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function fmt(dt: Date): string {
  return dt.toISOString().split("T")[0];
}

function mondayOf(d: Date): Date {
  const diff = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() - diff);
  return r;
}

/** Monday-aligned week starts (YYYY-MM-DD) whose weeks cover startDate..endDate. */
export function expectedWeekStarts(startDate: string, endDate: string): string[] {
  const first = mondayOf(parseUTC(startDate));
  const lastMonday = mondayOf(parseUTC(endDate));
  const out: string[] = [];
  for (const cur = new Date(first); cur <= lastMonday; cur.setUTCDate(cur.getUTCDate() + 7)) {
    out.push(fmt(cur));
  }
  return out;
}

/** Clamp a date into [weekStart, weekStart+6] (its Monday-aligned week bounds). */
export function repairSessionDate(date: string, weekStart: string): string {
  const d = parseUTC(date);
  const start = parseUTC(weekStart);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  if (d < start) return fmt(start);
  if (d > end) return fmt(end);
  return date;
}

/**
 * Clamp each week-over-week increase to `ceiling`, tolerating a single one-off
 * jump up to `burst` when the previous week did not itself burst — so a
 * progressive plan can step up once without sustaining a spike. Recovery drops
 * (any week below the prior) always pass through. Ceilings/bursts are fractions
 * (0.10 = +10%).
 */
export function clampWeeklyRamp(targets: number[], ceiling: number, burst: number): number[] {
  const out = [...targets];
  let prevBurst = false;
  for (let i = 1; i < out.length; i++) {
    const allowed = prevBurst ? ceiling : burst;
    const max = Math.round(out[i - 1] * (1 + allowed));
    if (out[i] > max) out[i] = max;
    prevBurst = out[i] > Math.round(out[i - 1] * (1 + ceiling));
  }
  return out;
}

/** Back-compat: the legacy flat +20% week-over-week clamp (no burst). */
export function clampVolumeRamp(targets: number[]): number[] {
  const ceiling = MAX_WEEKLY_RAMP - 1;
  return clampWeeklyRamp(targets, ceiling, ceiling);
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-baseline-anchored macro volume shaping (the anti-over-ramp injury guard).
// Pure functions over a weekly-target array; the node passes context values in.
// Constants are research-backed but tunable.
// ─────────────────────────────────────────────────────────────────────────────

// No recent running on record → anchor week 1 to a conservative re-entry floor
// rather than the race goal. ~20 km/wk is a safe restart base.
export const DEFAULT_BASELINE_WEEKLY_METERS = 20_000;

// Weekly ramp ceilings by the volume-aggressiveness dial. 10%/wk is the classic
// (folklore-but-standard) safe-progression rule; gradual/progressive bracket it.
// `burst` is a one-off week-over-week jump the clamp tolerates once — only
// meaningfully above `ceiling` for progressive (a single ~25% step-up).
export const VOLUME_RAMP: Record<VolumeAggressiveness, { ceiling: number; burst: number }> = {
  gradual: { ceiling: 0.07, burst: 0.07 },
  steady: { ceiling: 0.1, burst: 0.1 },
  progressive: { ceiling: 0.15, burst: 0.25 },
};

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
 * Force week 1 to the athlete's REAL trailing baseline (or a conservative floor
 * when there is no history) — never the race goal. Starting above what they are
 * actually running is the top cause of over-ramp injury.
 */
export function anchorWeekOne(targets: number[], baselineWeeklyMeters: number | null): number[] {
  if (targets.length === 0) return targets;
  const out = [...targets];
  out[0] = Math.round(baselineWeeklyMeters ?? DEFAULT_BASELINE_WEEKLY_METERS);
  return out;
}

/**
 * Cap each week's IMPLIED longest run (a fixed fraction of weekly volume) at a
 * ceiling that grows off the athlete's real recent longest run; scale the week's
 * volume down proportionally when it would spike the long run too fast. No-op
 * without a known recent longest run.
 */
export function capLongestRunSpike(targets: number[], longestRunMeters: number | null): number[] {
  if (longestRunMeters == null || longestRunMeters <= 0) return targets;
  const out = [...targets];
  for (let i = 0; i < out.length; i++) {
    const ceiling = longestRunMeters * (1 + LONG_RUN_SPIKE_CAP) * (1 + LONG_RUN_WEEKLY_GROWTH) ** i;
    const impliedLong = out[i] * IMPLIED_LONG_RUN_FRACTION;
    if (impliedLong > ceiling) out[i] = Math.round(ceiling / IMPLIED_LONG_RUN_FRACTION);
  }
  return out;
}

/**
 * Insert a recovery week every `DOWN_WEEK_CADENCE` build weeks at
 * `DOWN_WEEK_FACTOR` of the prior week. `buildWeeks` bounds the eligible range so
 * taper weeks (the tail) keep their own shaping.
 */
export function enforceDownWeeks(targets: number[], buildWeeks = targets.length): number[] {
  const out = [...targets];
  const limit = Math.min(buildWeeks, out.length);
  for (let i = 1; i < limit; i++) {
    if ((i + 1) % DOWN_WEEK_CADENCE === 0) out[i] = Math.round(out[i - 1] * DOWN_WEEK_FACTOR);
  }
  return out;
}

/** Final hard ceiling: no week exceeds the user's `maxWeeklyVolumeMeters`. */
export function capMaxWeekly(targets: number[], maxWeeklyVolumeMeters: number | null): number[] {
  if (maxWeeklyVolumeMeters == null) return targets;
  return targets.map((t) => Math.min(t, maxWeeklyVolumeMeters));
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
  volumeAggressiveness: VolumeAggressiveness;
  maxWeeklyVolumeMeters: number | null;
  raceDistanceMeters: number | null;
};

/**
 * Rebuild the macro's weeks against the authoritative Monday-aligned week grid:
 * week count/index/startDate come from the input range (never trusted from the
 * LLM); phases are constrained to the taper/race-near-the-end rule. Weekly
 * volumes are then shaped, in order: anchor week 1 to the real baseline → clamp
 * the week-over-week ramp to the aggressiveness ceiling → cap implied long-run
 * spikes → insert recovery weeks → taper the tail → hard-cap to the user's max.
 */
export function repairMacro(
  raw: PlanMacro,
  input: PlanBuilderInput,
  params: MacroShapingParams,
): PlanMacro {
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

  let targets = phased.map((w) => w.targetDistanceMeters);
  targets = anchorWeekOne(targets, params.baselineWeeklyMeters);
  targets = clampWeeklyRamp(targets, ramp.ceiling, ramp.burst);
  targets = capLongestRunSpike(targets, params.longestRunMeters);
  targets = enforceDownWeeks(targets, buildWeeks);

  let shaped: PlanMacroWeek[] = phased.map((w, i) => ({ ...w, targetDistanceMeters: targets[i] }));
  if (taperCount > 0) shaped = applyTaper(shaped, taperCount, raceAnchored);

  const capped = capMaxWeekly(
    shaped.map((w) => w.targetDistanceMeters),
    params.maxWeeklyVolumeMeters,
  );
  const final = shaped.map((w, i) => ({ ...w, targetDistanceMeters: capped[i] }));

  return { name: raw.name, rationale: raw.rationale, weeks: final };
}

function appendDistanceHint(description: string | null | undefined, meters: number): string {
  const hint = `~${(meters / 1000).toFixed(1)} km`;
  return description ? `${description} — ${hint}` : hint;
}

/**
 * Deterministically finalize one week's sessions: repair dates into the week,
 * null every pace, cap at 7/week, then distribute the week's remaining volume
 * budget across the structureless (easy/long/recovery) fill runs so the week's
 * estimated distance tracks the macro target.
 */
export function assembleWeekSessions(
  week: PlanMacroWeek,
  raw: GeneratedSession[],
): GeneratedSession[] {
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

  const structuredMeters = sessions.reduce(
    (n, s) => n + estimateStructureDistanceMeters(s.structure),
    0,
  );
  const fill = sessions.filter((s) => !s.structure || s.structure.length === 0);
  if (fill.length > 0) {
    const per = Math.round(Math.max(0, week.targetDistanceMeters - structuredMeters) / fill.length);
    for (const s of fill) s.description = appendDistanceHint(s.description, per);
  }

  return sessions;
}
