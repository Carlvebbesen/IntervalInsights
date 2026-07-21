// Dedicated bun-test preload for tests/pace_service.test.ts — the REAL
// pace-algorithm tests.
//
// WHY A SEPARATE PRELOAD:
// The default preload (tests/setup.ts, wired via bunfig.toml) globally mocks
// ../src/services/pace_service.ts AND ../src/services/lap_derivation_service.ts,
// so every endpoint test runs against stubs and never exercises the real
// algorithm. bun's mock.module registry is GLOBAL and uses ESM live bindings:
// once any file re-mocks lap_derivation_service, that change retroactively
// clobbers the binding inside an already-loaded real pace_service. That makes
// per-file bypass tricks (query-suffix imports, in-file re-mocks) fragile and
// order-dependent in the full suite. The robust fix is to run the pace tests in
// their OWN bun-test invocation with this preload, which simply NEVER mocks
// pace_service or lap_derivation_service. See tests/bunfig.pace.toml and
// scripts/test-pace.sh.
//
// This preload keeps only what's needed to import the real dep graph without
// real I/O: env-var defaults (config.ts validates them at import time) and leaf
// network mocks (Strava/intervals). The history tests seed interval
// segments in a real disposable Postgres, so getSegmentsForActivity hits its
// stored-rows fast path and never calls those leaves anyway; the mocks are
// cheap insurance for the import graph.

import { mock } from "bun:test";

process.env.NODE_ENV = "test";

const ENV_DEFAULTS: Record<string, string> = {
  STRAVA_CLIENT_ID: "111111",
  STRAVA_CLIENT_SECRET: "strava_secret_dummy",
  STRAVA_WEBHOOK_VERIFY_TOKEN: "verify-dummy",
  STRAVA_SUBSCRIPTION_ID: "999",
  INTERVALS_CLIENT_ID: "intervals_client_dummy",
  INTERVALS_CLIENT_SECRET: "intervals_secret_dummy",
  INTERVALS_WEBHOOK_SECRET: "intervals_webhook_secret_dummy",
  APP_BASE_URL: "http://localhost:3000/",
  OPENAI_API_KEY: "sk-test-openai-dummy",
  // config.ts requires a non-empty DATABASE_URL at import time. scripts/test-pace.sh
  // overrides this with the disposable Postgres URL before `bun test` runs; the
  // placeholder only needs to be non-empty so the import-time parse passes.
  DATABASE_URL: "postgres://placeholder:placeholder@localhost:5432/placeholder",
};
for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

// ── Leaf network mocks only — pace_service / lap_derivation_service stay REAL ──
mock.module("../src/services/strava_api_service.ts", () => ({
  stravaApiService: {
    getActivity: async () => ({ id: 1, splits_metric: [] }),
    getGear: async (_t: string, id: string) => ({ id, name: `Mock Gear ${id}`, distance: 0, retired: false }),
    getActivityStreams: async () => ({}),
    getActivityLaps: async () => [],
    listAthleteActivities: async () => [],
    syncStravaActivities: async (_t: string, _u: string, ids: number[]) =>
      ids.map((id) => ({ id, status: "success" as const })),
  },
}));

mock.module("../src/services/intervals_api_service.ts", () => ({
  intervalsApiService: {
    getAthlete: async () => ({ id: "i12345" }),
    getWellness: async () => [],
    getActivity: async () => null,
    listActivities: async () => [],
    getActivityStreams: async () => ({}),
    getActivityIntervals: async () => ({ icu_intervals: [] }),
  },
}));

