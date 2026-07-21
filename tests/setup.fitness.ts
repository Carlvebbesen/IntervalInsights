// Dedicated bun-test preload for tests/wellness_service_computed.test.ts — the
// REAL intervals_wellness_service tests (self-computed fitness swap, wave 2).
//
// WHY A SEPARATE PRELOAD:
// The default preload (tests/setup.ts) globally mocks
// ../src/services/intervals_wellness_service.ts, so no endpoint/service test in
// the main suite ever runs the real computed-fitness swap. bun's mock.module
// registry is global with ESM live bindings, so per-file un-mock tricks are
// fragile. This preload simply NEVER mocks intervals_wellness_service /
// fitness_service / fitness_metrics_service — it mocks only the leaf network
// modules (Strava + intervals REST), so the real fold runs against a disposable
// Postgres with no external I/O. See tests/bunfig.fitness.toml + scripts/test-fitness.sh.
//
// Wellness records are driven per-test through the mutable `wellnessStub`.

import { mock } from "bun:test";
import { wellnessStub } from "./helpers/wellness_stub";

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
  TOKEN_ENC_KEY: "test-token-enc-key-0123456789-abcdefghij",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789-abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  RESEND_API_KEY: "re_test_dummy",
  // scripts/test-fitness.sh overrides this with the disposable Postgres URL.
  DATABASE_URL: "postgres://placeholder:placeholder@localhost:5432/placeholder",
};
for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

// Wellness records are driven per-test via the shared `wellnessStub` handle
// (tests/helpers/wellness_stub.ts).

// ── Leaf network mocks only — intervals_wellness_service stays REAL ──
mock.module("../src/services/strava_api_service.ts", () => ({
  stravaApiService: {
    getActivity: async () => ({ id: 1, splits_metric: [] }),
    getActivityStreams: async () => ({}),
    getActivityLaps: async () => [],
    listAthleteActivities: async () => [],
  },
}));

mock.module("../src/services/intervals_api_service.ts", () => ({
  DEFAULT_INTERVALS_STREAM_TYPES: [],
  intervalsApiService: {
    getAthlete: async () => ({ id: "i12345" }),
    getWellness: async () => wellnessStub.records,
    getActivity: async () => null,
    listActivities: async () => [],
  },
}));
