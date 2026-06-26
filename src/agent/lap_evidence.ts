import { classifyLaps, isJunkLap } from "../services/deterministic_segmenter";
import type { Lap } from "../types/strava/IDetailedActivity";

/**
 * Deterministic lap-evidence hint for the classifier.
 *
 * The classifier otherwise sees only the title, a 30s-sampled stream table, and the
 * intervals.icu prediction block. None of those reliably surface a clean rep grid:
 * a colloquial title ("6x varme tusninger") can't be decoded into a per-rep size,
 * the 30s sampling smears reps, and intervals.icu frequently labels EVERY manual lap
 * `WORK` (recoveries included), so its block reads as noise. Yet the athlete's own
 * lap markers usually encode the structure exactly — `classifyLaps` already isolates
 * the fast WORK laps from warmup/cooldown/recovery by pace.
 *
 * This builds a small markdown block stating that deterministic work/rest split so
 * the LLM can classify the interval session it would otherwise collapse to EASY.
 * Returns "" unless the laps form a clear repeating grid (see the guards), so steady
 * runs with per-km auto-laps don't get a fake structure.
 */

const MIN_WORK_REPS = 3;
const MIN_WORK_REST_CONTRAST = 1.25;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function paceMinKm(speedMs: number): string {
  if (speedMs <= 0) return "-";
  const secPerKm = 1000 / speedMs;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function buildLapEvidenceBlock(laps: Lap[] | undefined, time: number[]): string {
  if (!laps || laps.length === 0 || time.length === 0) return "";

  const cls = classifyLaps(laps, time);
  // Only the per-rep mode isolates individual reps; boundary/unusable can't.
  if (cls.mode !== "per-rep") return "";

  const work = cls.workLaps;
  if (work.length < MIN_WORK_REPS) return "";

  const meaningful = laps.filter((l) => !isJunkLap(l));
  const workSet = new Set(work);
  const nonWork = meaningful.filter((l) => !workSet.has(l));
  // No warmup / recovery / cooldown laps at all → laps are uniform (e.g. steady run
  // auto-lapped every km), not a work/rest grid. Don't invent a structure.
  if (nonWork.length === 0) return "";

  const workSpeed = median(work.map((l) => l.average_speed ?? 0));
  const restSpeed = median(nonWork.map((l) => l.average_speed ?? 0));
  // Work must be clearly faster than the rest of the laps, or it isn't an interval.
  if (workSpeed <= 0 || restSpeed <= 0 || workSpeed < restSpeed * MIN_WORK_REST_CONTRAST) {
    return "";
  }

  const firstWorkIdx = laps.indexOf(work[0]);
  const lastWorkIdx = laps.indexOf(work[work.length - 1]);
  const recoveries = laps
    .filter((l, i) => i > firstWorkIdx && i < lastWorkIdx && !workSet.has(l) && !isJunkLap(l))
    .map((l) => l.moving_time ?? l.elapsed_time ?? 0)
    .filter((s) => s > 0);
  const recoveryMed = recoveries.length ? Math.round(median(recoveries)) : null;

  const rows = work
    .map((l, i) => {
      const dist = Math.round(l.distance ?? 0);
      const dur = Math.round(l.moving_time ?? l.elapsed_time ?? 0);
      const hr = l.average_heartrate != null ? `${Math.round(l.average_heartrate)}` : "-";
      return `| ${i + 1} | ${dist} m | ${dur} s | ${paceMinKm(l.average_speed ?? 0)} | ${hr} |`;
    })
    .join("\n");

  const recoveryLine =
    recoveryMed != null ? ` Typical recovery between reps: ~${recoveryMed} s.` : "";
  const contrast = (workSpeed / restSpeed).toFixed(1);

  return `
  ### DEVICE LAP EVIDENCE (deterministic work/rest split from the athlete's own lap markers — recoveries removed by pace)
  The athlete's laps isolate **${work.length} work reps** (warmup, cooldown and recovery jogs excluded by pace):
  | Rep | Distance | Duration | Pace (min/km) | Avg HR |
  |-----|----------|----------|---------------|--------|
${rows}
 ${recoveryLine} Work pace is ~${contrast}× the recovery pace — a clear repeating structure.
  Treat this as STRONG evidence of a deliberate interval session: classify as the matching interval type and size the SHORT vs LONG gate from the per-rep distance/duration above, even when the Title is ambiguous or non-English and the 30s table looks steady.
  The ${work.length} rows above are the INDIVIDUAL reps; the session totals ${work.length} work reps. When they are one repeated effort (e.g. "${work.length}x1000m"), the structure is a single step with reps:${work.length} — not ${work.length} separate steps.
`;
}
