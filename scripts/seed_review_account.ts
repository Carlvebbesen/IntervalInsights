// Re-runnable refresh of the store-review demo account: prepare + force a full
// corpus reseed (dates advance to now, self-healing any reviewer mutation).
// No-ops when the REVIEW_ACCOUNT_* env pair is unset. Run before each submission
// (e.g. as a Railway one-off) to freshen the demo data. Not a run-once script.
import { db, pool } from "../src/db";
import { seedReviewAccountData } from "../src/services/review_demo/seed";
import { runScript } from "./_harness";

runScript({ name: "seed_review_account", once: false, db, pool }, async () => {
  await seedReviewAccountData();
});
