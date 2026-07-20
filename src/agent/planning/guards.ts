import { AppError } from "../../error";
import type { TrainingType } from "../../schema/enums";
import { INTERVAL_TRAINING_TYPES, type PlanWeekPhase, trainingBucketFor } from "../../schema/enums";
import type { WorkoutStructureSet } from "../../schemas/agent_schemas";
import type { GeneratedSession, PlanMacro, PlanMacroWeek } from "./plan_builder_schemas";
import type {
  IntensityAggressiveness,
  PlanBuilderInput,
  VolumeAggressiveness,
} from "./plan_builder_state";

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

function addDays(dateStr: string, days: number): string {
  const d = parseUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

function daysBetween(a: string, b: string): number {
  return Math.abs((parseUTC(b).getTime() - parseUTC(a).getTime()) / 86_400_000);
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

/**
 * Clamp a date into [weekStart, weekStart+6] (its Monday-aligned week bounds).
 * An unparsable date falls back to the week start — a NaN date fails BOTH bound
 * comparisons, so returning it unchanged would pass malformed text through to
 * the persisted session.
 */
export function repairSessionDate(date: string, weekStart: string): string {
  const d = parseUTC(date);
  const start = parseUTC(weekStart);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  if (Number.isNaN(d.getTime())) return fmt(start);
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

/**
 * The ramp invariant enforced on the FINAL shaped output, measured against the
 * running PEAK of the preceding weeks rather than the immediately prior week.
 *
 * Why peak-relative: later shaping stages (`enforceDownWeeks`, `capLongestRunSpike`,
 * `capMaxWeekly`) lower individual weeks, which re-opens headroom a purely
 * prev-relative clamp already spent — a 72% down week made the next week a +39%
 * jump. Re-clamping against the prior week instead would flatten the plan into
 * the down week and destroy the recovery-then-rebuild shape. Stepping back up to
 * the pre-down-week peak after a recovery week is the intended (and
 * physiologically correct) block-periodization shape; what must never happen is
 * exceeding the ceiling relative to the trajectory the athlete had already
 * reached. So: no week may exceed the highest week before it by more than
 * `ceiling` (one `burst` tolerated, as in `clampWeeklyRamp`).
 */
export function clampRampAgainstPeak(targets: number[], ceiling: number, burst: number): number[] {
  const out = [...targets];
  let peak = out[0] ?? 0;
  let prevBurst = false;
  for (let i = 1; i < out.length; i++) {
    const allowed = prevBurst ? ceiling : burst;
    const max = Math.round(peak * (1 + allowed));
    if (out[i] > max) out[i] = max;
    prevBurst = out[i] > Math.round(peak * (1 + ceiling));
    peak = Math.max(peak, out[i]);
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
 * actually running is the top cause of over-ramp injury. A baseline that is
 * non-finite or below `MIN_BASELINE_WEEKLY_METERS` is treated as ABSENT:
 * anchoring week 1 to 0 (or to 1 metre) propagates through the whole ramp and
 * yields a plan of zero-kilometre weeks.
 */
export function anchorWeekOne(targets: number[], baselineWeeklyMeters: number | null): number[] {
  if (targets.length === 0) return targets;
  const usable =
    baselineWeeklyMeters != null &&
    Number.isFinite(baselineWeeklyMeters) &&
    baselineWeeklyMeters >= MIN_BASELINE_WEEKLY_METERS
      ? baselineWeeklyMeters
      : DEFAULT_BASELINE_WEEKLY_METERS;
  const out = [...targets];
  out[0] = Math.round(usable);
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
 * volumes are then shaped, in order: anchor week 1 to the real baseline → carry
 * missing targets forward → clamp the week-over-week ramp to the aggressiveness
 * ceiling → cap implied long-run spikes → hard-cap to the user's max → insert
 * recovery weeks → taper the tail → re-clamp the ramp against the running peak →
 * hard-cap again. The guarantees are asserted on the FINAL array, not per stage.
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
  targets = floorWeeklyTargets(targets);
  targets = clampWeeklyRamp(targets, ramp.ceiling, ramp.burst);
  targets = capLongestRunSpike(targets, params.longestRunMeters);
  // Hard-cap BEFORE the taper so the taper's staged fractions come off an
  // already-capped build week and stay strictly decreasing (capping afterwards
  // flattens the first taper weeks onto the same ceiling value).
  targets = capMaxWeekly(targets, params.maxWeeklyVolumeMeters);
  targets = enforceDownWeeks(targets, buildWeeks);

  let shaped: PlanMacroWeek[] = phased.map((w, i) => ({ ...w, targetDistanceMeters: targets[i] }));
  if (taperCount > 0) shaped = applyTaper(shaped, taperCount, raceAnchored);

  // Final passes: every stage above can lower a week, so the ramp invariant is
  // re-established on the finished array (see `clampRampAgainstPeak`), then the
  // user's hard ceiling is re-applied. Both only ever lower a week, so neither
  // can reopen the long-run spike cap.
  const capped = capMaxWeekly(
    clampRampAgainstPeak(
      shaped.map((w) => w.targetDistanceMeters),
      ramp.ceiling,
      ramp.burst,
    ),
    params.maxWeeklyVolumeMeters,
  );
  const final = shaped.map((w, i) => ({ ...w, targetDistanceMeters: capped[i] }));

  return { name: raw.name, rationale: raw.rationale, weeks: final };
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

/**
 * Enforce the polarization cap: keep at most `qualityCap` hard sessions (the
 * earliest by date), downgrading any excess hard session to an easy run. Never
 * fabricates hard work when there are too few — the cap is a ceiling.
 */
export function enforceQualityCount(
  sessions: GeneratedSession[],
  phase: PlanWeekPhase,
  intensity: IntensityAggressiveness,
): GeneratedSession[] {
  const cap = qualityCap(phase, intensity);
  const out = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  let kept = 0;
  return out.map((s) => {
    if (!isHardSession(s.sessionType, s.structure)) return s;
    kept += 1;
    return kept > cap ? downgradeToEasy(s) : s;
  });
}

/**
 * Space hard sessions so no two land on consecutive calendar days: when a hard
 * session sits within 1 day of the previous hard one, swap its date with a later
 * easy session that clears the gap. Best-effort — a no-op when nothing swappable.
 * Each swap strictly moves a hard session later, so the scan terminates.
 */
export function spaceHardSessions(sessions: GeneratedSession[]): GeneratedSession[] {
  const s = sessions.map((x) => ({ ...x })).sort((a, b) => a.date.localeCompare(b.date));
  const hard = (x: GeneratedSession) => isHardSession(x.sessionType, x.structure);
  for (let guard = 0, i = 1; i < s.length && guard < 64; i++) {
    if (!hard(s[i])) continue;
    let prev = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (hard(s[k])) {
        prev = k;
        break;
      }
    }
    if (prev < 0 || daysBetween(s[prev].date, s[i].date) > 1) continue;
    for (let j = i + 1; j < s.length; j++) {
      if (hard(s[j]) || daysBetween(s[prev].date, s[j].date) < 2) continue;
      const tmp = s[i].date;
      s[i].date = s[j].date;
      s[j].date = tmp;
      s.sort((a, b) => a.date.localeCompare(b.date));
      guard += 1;
      i = 0; // restart: dates shifted
      break;
    }
  }
  return s;
}

/**
 * Guarantee the "never two hard days back-to-back" rule that `spaceHardSessions`
 * can only best-effort: when the week has no swappable easy day (e.g. 3 quality
 * sessions on a 3-run-day week), re-dating cannot separate them, so the later
 * hard session is downgraded to easy instead — same choice `enforceQualityCount`
 * makes for excess quality. Run last, after all date shuffling.
 */
export function downgradeAdjacentHardSessions(sessions: GeneratedSession[]): GeneratedSession[] {
  const s = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  let lastHard: string | null = null;
  return s.map((x) => {
    if (!isHardSession(x.sessionType, x.structure)) return x;
    if (lastHard != null && daysBetween(lastHard, x.date) <= 1) return downgradeToEasy(x);
    lastHard = x.date;
    return x;
  });
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
 * Cap the week at `daysPerWeek` run days (the rest are rest days): drop the
 * latest easy/recovery fill runs first, protecting hard and long sessions; only
 * if still over do we drop protected sessions from the tail. Never adds sessions
 * (too-few is handled by the volume-fill logic).
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
  const protectedSession = (x: GeneratedSession) =>
    isHardSession(x.sessionType, x.structure) || trainingBucketFor(x.sessionType) === "LONG";
  for (let i = s.length - 1; i >= 0 && excess > 0; i--) {
    if (!protectedSession(s[i])) {
      keep[i] = false;
      excess -= 1;
    }
  }
  for (let i = s.length - 1; i >= 0 && excess > 0; i--) {
    if (keep[i]) {
      keep[i] = false;
      excess -= 1;
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

/** Move the week's long-bucket session (LONG / PROGRESSIVE_LONG) onto the preferred long-run day. */
export function placeLongRun(
  sessions: GeneratedSession[],
  weekStart: string,
  preferredLongRunDay: number | null | undefined,
): GeneratedSession[] {
  const target = addDays(weekStart, longRunOffset(preferredLongRunDay));
  const s = sessions.map((x) => ({ ...x }));
  const idx = s.findIndex((x) => trainingBucketFor(x.sessionType) === "LONG");
  if (idx >= 0) s[idx].date = target;
  return s.sort((a, b) => a.date.localeCompare(b.date));
}

// A cross-training session is represented as a plain `OTHER` run-type with no
// structure — the schema has no dedicated cross-training value (OTHER is the
// catch-all). The app renders OTHER; the title/description carry the intent.
export const CROSS_TRAINING_TITLE = "Cross-training (elliptical / bike / pool)";
const CROSS_TRAINING_DESCRIPTION =
  "Cross-training substitute for an easy run to protect the active injury — same duration/load.";
export const MAX_CROSS_TRAINING_PER_WEEK = 2;

function toCrossTraining(s: GeneratedSession): GeneratedSession {
  return {
    ...s,
    sessionType: "OTHER",
    structure: null,
    title: CROSS_TRAINING_TITLE,
    description: CROSS_TRAINING_DESCRIPTION,
  };
}

/**
 * For an athlete with an active injury: convert up to `count` (capped 1–2)
 * EASY/RECOVERY runs into cross-training sessions, protecting the injury while
 * preserving easy volume 1:1. Never touches a LONG or quality session, and only
 * acts in weeks with ≥2 easy runs to spare.
 */
export function substituteCrossTraining(
  sessions: GeneratedSession[],
  count: number,
): GeneratedSession[] {
  const want = Math.min(MAX_CROSS_TRAINING_PER_WEEK, Math.max(0, count));
  if (want === 0) return sessions;
  const easyIdx = sessions
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) =>
        (s.sessionType === "EASY" || s.sessionType === "RECOVERY") &&
        !isHardSession(s.sessionType, s.structure),
    )
    .map(({ i }) => i);
  if (easyIdx.length < 2) return sessions;
  const convert = new Set(easyIdx.slice(0, Math.min(want, easyIdx.length)));
  return sessions.map((s, i) => (convert.has(i) ? toCrossTraining(s) : s));
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
};

function appendDistanceHint(description: string | null | undefined, meters: number): string {
  const hint = `~${(meters / 1000).toFixed(1)} km`;
  return description ? `${description} — ${hint}` : hint;
}

/**
 * Deterministically finalize one week's sessions. Order: repair dates into the
 * week + null every pace → cap at 7/week → enforce the polarization quality cap
 * (downgrade excess hard runs) → cap to the athlete's run-day count → space hard
 * sessions off consecutive days → pin the long run to the preferred day →
 * downgrade any hard session spacing could not separate → substitute easy runs with cross-training around an active injury → distribute
 * the remaining volume budget across the structureless fill runs (cross-training
 * sessions have null structure, so pace-nulling and this fill both apply to them
 * unchanged). All shaping steps are pure; the node passes settings in `params`.
 */
export function assembleWeekSessions(
  week: PlanMacroWeek,
  raw: GeneratedSession[],
  params: SessionGuardParams,
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

  sessions = enforceQualityCount(sessions, week.phase, params.intensityAggressiveness);
  sessions = enforceDaysPerWeek(sessions, params.daysPerWeek);
  // Pin the long run AFTER spacing: `spaceHardSessions` swaps a hard session's
  // date with a later easy one, and the long run is an eligible swap partner —
  // pinning first let spacing move it straight back off the preferred day.
  sessions = spaceHardSessions(sessions);
  sessions = placeLongRun(sessions, week.startDate, params.preferredLongRunDay);
  sessions = downgradeAdjacentHardSessions(sessions);
  sessions = substituteCrossTraining(sessions, params.crossTrainingCount);
  sessions.sort((a, b) => a.date.localeCompare(b.date));

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
