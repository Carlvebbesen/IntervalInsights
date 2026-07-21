// Ordered registry of run-once scripts. Keep in sync with the `once: true`
// scripts in this directory.
export const ONCE_SCRIPTS = [
  "backfill_events",
  "backfill_gears",
  "backfill_hr_stats",
  "backfill_user_settings",
  "run_backfill_fold",
] as const;
