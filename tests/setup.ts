// Bun test preload. Runs once before any test file is evaluated.
// Sets safe env-var defaults so the routers (which call requireEnv at import
// time) can load, and registers module mocks for every external service the
// endpoints depend on.

import { mock } from "bun:test";

process.env.NODE_ENV = "test";

// Required by routers at module-load time.
const ENV_DEFAULTS: Record<string, string> = {
  CLERK_SECRET_KEY: "sk_test_dummy",
  CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
  STRAVA_CLIENT_ID: "111111",
  STRAVA_CLIENT_SECRET: "strava_secret_dummy",
  STRAVA_WEBHOOK_VERIFY_TOKEN: "verify-dummy",
  STRAVA_SUBSCRIPTION_ID: "999",
  INTERVALS_CLIENT_ID: "intervals_client_dummy",
  INTERVALS_CLIENT_SECRET: "intervals_secret_dummy",
  INTERVALS_WEBHOOK_SECRET: "intervals_webhook_secret_dummy",
  APP_BASE_URL: "http://localhost:3000/",
  OPENAI_API_KEY: "sk-test-openai-dummy",
  PROGRESS_HEARTBEAT_MS: "200",
};

for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

// ─── Mocks for service modules ────────────────────────────────────────────────
// Each test file may override these per-test via mock.module again, but the
// defaults are sensible no-ops / empty data so endpoints just return.

mock.module("../src/services/strava_api_service.ts", () => ({
  stravaApiService: {
    getActivity: async () => ({ id: 1, splits_metric: [] }),
    getGear: async (_t: string, id: string) => ({
      id,
      name: `Mock Gear ${id}`,
      distance: 0,
      retired: false,
    }),
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
  },
}));

mock.module("../src/services/intervals_wellness_service.ts", () => ({
  fetchWellnessSummary: async () => null,
  fetchTrainingSummary: async () => ({ status: "not_linked", data: null }),
  fetchWellnessSeries: async () => ({ status: "not_linked", data: null }),
  fetchWeekWellnessStats: async () => null,
}));

mock.module("../src/services/analysis_service.ts", () => {
  class ResumeValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ResumeValidationError";
    }
  }
  return {
    ResumeValidationError,
    startAnalysis: async () => {},
    resumeAnalysis: async () => {},
    restartAnalysisByStravaId: async () => {},
  };
});

mock.module("../src/services/requeue_service.ts", () => ({
  requeueStaleActivities: async () => {},
}));

mock.module("../src/services/process_strava_event.ts", () => ({
  processStravaWebhook: async () => {},
}));

mock.module("../src/services/process_intervals_event.ts", () => ({
  processIntervalsWebhook: async () => {},
}));

mock.module("../src/services/pace_service.ts", () => ({
  getProposedPaceForStructure: async () => [],
  getProposedPaceFromLaps: () => null,
}));

mock.module("../src/services/lap_derivation_service.ts", () => ({
  getSegmentsForActivity: async () => [],
  matchLapsToExpandedSteps: () => [],
  structureShapeMatches: () => false,
  buildSegmentsFromLaps: () => null,
}));

mock.module("../src/agent/parse_intervals_agent.ts", () => ({
  invokeParseIntervalsAgent: async () => ({ sets: [] }),
}));

// Clerk: the real client makes HTTPS calls. Stub everything to no-op.
// privateMetadata returns valid-looking Strava+Intervals tokens so the real
// strava/intervals middlewares (which run inside their routers) don't bail
// with a 403 during tests.
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86_400;
mock.module("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUser: async () => ({
        privateMetadata: {
          strava: {
            access_token: "test-strava-token",
            refresh_token: "test-strava-refresh",
            expires_at: FAR_FUTURE,
            athlete_id: 12345,
          },
          intervals: {
            access_token: "test-intervals-token",
            refresh_token: "test-intervals-refresh",
            expires_at: FAR_FUTURE,
            athlete_id: "i12345",
          },
        },
        publicMetadata: {},
      }),
      updateUserMetadata: async () => ({}),
    },
  }),
}));

// Clerk Hono helpers: we never want the real JWT check in tests. The test app
// (tests/helpers/test_app.ts) replaces auth entirely; these stubs just keep
// imports happy if any production code path still references them.
mock.module("@hono/clerk-auth", () => {
  const noopMiddleware = async (_c: unknown, next: () => Promise<void>) => {
    await next();
  };
  return {
    clerkMiddleware: () => noopMiddleware,
    getAuth: () => ({ userId: "clerk_test_user" }),
  };
});
