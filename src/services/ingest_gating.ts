const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const INACTIVITY_SKIP_DAYS = 60;
export const INACTIVITY_DROP_DAYS = 90;

export function classifyUserActivity(lastSeenAt: Date | null): "active" | "skip" | "drop" {
  if (lastSeenAt == null) return "active";
  const daysSince = (Date.now() - lastSeenAt.getTime()) / MS_PER_DAY;
  if (daysSince > INACTIVITY_DROP_DAYS) return "drop";
  if (daysSince > INACTIVITY_SKIP_DAYS) return "skip";
  return "active";
}
