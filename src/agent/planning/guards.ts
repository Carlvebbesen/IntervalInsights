import type { WorkoutStructureSet } from "../../schemas/agent_schemas";
import type { GeneratedSession, PlanMacro, PlanMacroWeek } from "./plan_builder_schemas";
import type { PlanBuilderInput } from "./plan_builder_state";

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

/** No week may grow > 20% over the previous week; recovery drops pass through. */
export function clampVolumeRamp(targets: number[]): number[] {
  const out = [...targets];
  for (let i = 1; i < out.length; i++) {
    const max = Math.round(out[i - 1] * MAX_WEEKLY_RAMP);
    if (out[i] > max) out[i] = max;
  }
  return out;
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
 * Rebuild the macro's weeks against the authoritative Monday-aligned week grid:
 * week count/index/startDate come from the input range (never trusted from the
 * LLM); phases are constrained to the taper/race-near-the-end rule; volumes are
 * ramp-clamped.
 */
export function repairMacro(raw: PlanMacro, input: PlanBuilderInput): PlanMacro {
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
  const clampedTargets = clampVolumeRamp(phased.map((w) => w.targetDistanceMeters));
  const clamped = phased.map((w, i) => ({ ...w, targetDistanceMeters: clampedTargets[i] }));

  return { name: raw.name, rationale: raw.rationale, weeks: clamped };
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
