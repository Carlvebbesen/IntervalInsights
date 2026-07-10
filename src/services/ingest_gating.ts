// Shared inactivity gate for freshly-ingested activities. Used by both webhook
// create paths (Strava and intervals.icu) so a long-dormant user never triggers
// LLM spend on a passive backfill from either source.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const INACTIVITY_SKIP_DAYS = 60;
export const INACTIVITY_DROP_DAYS = 90;

/**
 * Classify how to treat a new activity based on the user's last-seen time
 * (bumped by `authGuard`, at most hourly):
 * - `drop`   — inactive > DROP days: discard the event entirely.
 * - `skip`   — inactive SKIP–DROP days: store it, but never auto-analyze
 *              (`analysisStatus = 'skipped_inactive'`); re-queued by `/pending`.
 * - `active` — store and analyze normally.
 */
export function classifyUserActivity(lastSeenAt: Date | null): "active" | "skip" | "drop" {
  if (lastSeenAt == null) return "active";
  const daysSince = (Date.now() - lastSeenAt.getTime()) / MS_PER_DAY;
  if (daysSince > INACTIVITY_DROP_DAYS) return "drop";
  if (daysSince > INACTIVITY_SKIP_DAYS) return "skip";
  return "active";
}
