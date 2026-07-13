// Ordered registry of run-once scripts. Keep in sync with the `once: true`
// scripts in this directory; clerk sync runs last.
export const ONCE_SCRIPTS = [
  "backfill_events",
  "backfill_gears",
  "backfill_hr_stats",
  "backfill_user_settings",
  "run_backfill_fold",
  "sync_clerk_to_db",
] as const;
