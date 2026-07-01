import * as dashboardRepo from "../repositories/dashboard_repository";
import * as structureRepo from "../repositories/interval_structure_repository";
import { RUNNING_SPORT_TYPES } from "../schema/enums";
import type { IGlobalBindings } from "../types/IRouters";
import { fetchPaceAnchor } from "./pace_anchor_service";

type Db = IGlobalBindings["db"];

const PROFILE_WINDOW_DAYS = 90;
const WEEKLY_WINDOW_DAYS = 84; // 12 weeks

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function fmtSecPerKm(sec: number | null | undefined): string | null {
  if (sec == null || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

const prettyType = (t: string): string => t.replace(/_/g, " ").toLowerCase();

/**
 * A compact, human-readable snapshot of who this athlete is — recent weekly
 * mileage, run/interval volume, easy-vs-quality mix, fitness (VDOT + paces), and
 * their habitual interval sessions — assembled from existing dashboard / pace-anchor
 * aggregations. Fed to the suggest-session agent so it can tailor to the athlete
 * instead of guessing. Every source is best-effort: a failure or missing datum
 * drops its line rather than the whole block. Returns "" when nothing is known.
 */
export async function buildAthleteProfileBlock(
  db: Db,
  userId: string,
  clerkUserId: string,
  now: Date,
): Promise<string> {
  const runningTypes = [...RUNNING_SPORT_TYPES];
  const since90 = new Date(now);
  since90.setUTCDate(since90.getUTCDate() - PROFILE_WINDOW_DAYS);
  const since84 = new Date(now);
  since84.setUTCDate(since84.getUTCDate() - WEEKLY_WINDOW_DAYS);

  const [weekly, longTerm, mix, anchor, structures] = await Promise.all([
    dashboardRepo.weeklyRunDistanceSince(db, userId, runningTypes, since84).catch(() => []),
    dashboardRepo.longTermRunStatsSince(db, userId, runningTypes, since90).catch(() => null),
    dashboardRepo.trainingTypeDistribution(db, userId, since90, now).catch(() => []),
    fetchPaceAnchor(db, userId, clerkUserId, now).catch(() => null),
    structureRepo.listDistinctForUser(db, userId).catch(() => []),
  ]);

  const lines: string[] = [];

  const weeklyKm = (weekly ?? [])
    .map((w) => num(w.totalDistance))
    .filter((n): n is number => n != null)
    .map((m) => m / 1000);
  if (weeklyKm.length > 0) {
    // The most recent bucket is usually a partial week — exclude it from the average.
    const full = weeklyKm.length > 1 ? weeklyKm.slice(0, -1) : weeklyKm;
    const avg = full.reduce((a, b) => a + b, 0) / full.length;
    const min = Math.min(...full);
    const max = Math.max(...full);
    lines.push(
      `- Weekly running volume: ~${Math.round(avg)} km/wk average over ${full.length} wk (range ${Math.round(min)}–${Math.round(max)} km)`,
    );
  }

  if (longTerm) {
    const sessions = num(longTerm.totalSessions);
    const intervals = num(longTerm.totalIntervals);
    const avgRunM = num(longTerm.avgDistancePerRun);
    const parts: string[] = [];
    if (sessions != null) parts.push(`${sessions} runs`);
    if (intervals != null) parts.push(`${intervals} interval/quality sessions`);
    if (avgRunM != null) parts.push(`avg ${(avgRunM / 1000).toFixed(1)} km/run`);
    if (parts.length > 0) lines.push(`- Last ${PROFILE_WINDOW_DAYS} days: ${parts.join(", ")}`);
  }

  const mixRows = (mix ?? []).flatMap((r) =>
    r.trainingType != null
      ? [{ type: r.trainingType, load: num(r.totalLoad) ?? 0, sessions: num(r.sessions) ?? 0 }]
      : [],
  );
  const totalLoad = mixRows.reduce((a, r) => a + r.load, 0);
  const bySessions = totalLoad <= 0;
  const denom = bySessions ? mixRows.reduce((a, r) => a + r.sessions, 0) : totalLoad;
  if (denom > 0) {
    const mixStr = mixRows
      .map((r) => ({
        type: r.type,
        pct: Math.round(((bySessions ? r.sessions : r.load) / denom) * 100),
      }))
      .filter((r) => r.pct > 0)
      .sort((a, b) => b.pct - a.pct)
      .map((r) => `${r.pct}% ${prettyType(r.type)}`)
      .join(", ");
    if (mixStr) lines.push(`- Training mix by ${bySessions ? "sessions" : "load"}: ${mixStr}`);
  }

  if (anchor && anchor.status === "ok" && anchor.data.anchorSource !== "none") {
    const d = anchor.data;
    const bits: string[] = [];
    if (d.vdot != null) bits.push(`VDOT ~${Math.round(d.vdot)}`);
    const paceBits = [
      fmtSecPerKm(d.paces.thresholdSecPerKm) && `threshold ${fmtSecPerKm(d.paces.thresholdSecPerKm)}`,
      fmtSecPerKm(d.paces.intervalSecPerKm) && `interval ${fmtSecPerKm(d.paces.intervalSecPerKm)}`,
      fmtSecPerKm(d.paces.easySecPerKm) && `easy ${fmtSecPerKm(d.paces.easySecPerKm)}`,
    ].filter(Boolean);
    if (paceBits.length > 0) bits.push(paceBits.join(", "));
    if (bits.length > 0) lines.push(`- Fitness: ${bits.join(" — ")}`);
  }

  const habitual = (structures ?? [])
    .filter((s) => (num(s.activityCount) ?? 0) > 0)
    .sort((a, b) => (num(b.activityCount) ?? 0) - (num(a.activityCount) ?? 0))
    .slice(0, 4)
    .map((s) => `${s.name} (${num(s.activityCount)}×)`);
  if (habitual.length > 0) lines.push(`- Habitual interval sessions: ${habitual.join(", ")}`);

  if (lines.length === 0) return "";
  return `### ATHLETE PROFILE (recent training)\n${lines.join("\n")}`;
}
