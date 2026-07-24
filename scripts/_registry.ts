// Ordered registry of run-once scripts — this is the RUN order for `scripts:run`.
// It must list exactly the `once: true` scripts in this directory; `scripts:status`
// diffs it against the source and fails on drift.
export const ONCE_SCRIPTS = [
  "backfill_canonical_signatures",
  "backfill_events",
  "backfill_gears",
  "backfill_hr_stats",
  "backfill_user_settings",
  "run_backfill_fold",
] as const;
