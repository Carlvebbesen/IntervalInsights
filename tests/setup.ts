// Bun test preload. Runs once before any test file is evaluated.
// Sets safe env-var defaults so the routers (which call requireEnv at import
// time) can load, and registers module mocks for every external service the
// endpoints depend on.

import { mock } from "bun:test";
import { z } from "zod";

process.env.NODE_ENV = "test";

// Required by routers at module-load time.
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
  PROGRESS_HEARTBEAT_MS: "200",
  SSE_HEARTBEAT_MS: "40",
  TOKEN_ENC_KEY: "test-token-enc-key-0123456789-abcdefghij",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789-abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  RESEND_API_KEY: "re_test_dummy",
  REVIEW_ACCOUNT_EMAIL: "store-review@test.local",
  REVIEW_ACCOUNT_OTP: "731409",
};

for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

// Bun auto-loads the worktree `.env`, whose URLs point at prod — force the ones
// tests assert on (e.g. the MCP protected-resource `resource`) to localhost so
// the suite is hermetic regardless of the developer's `.env`.
const ENV_FORCE: Record<string, string> = {
  APP_BASE_URL: "http://localhost:3000/",
  BETTER_AUTH_URL: "http://localhost:3000",
};
for (const [key, value] of Object.entries(ENV_FORCE)) {
  process.env[key] = value;
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
  DEFAULT_INTERVALS_STREAM_TYPES: [
    "time",
    "heartrate",
    "watts",
    "velocity_smooth",
    "distance",
    "altitude",
    "cadence",
  ],
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

// Mutable delegate: a test file may swap this (e.g. to count/assert calls)
// and MUST call reset() when done — the mock is global across files.
export const analysisServiceMock = {
  triggerAnalysisByStravaId: async (..._args: unknown[]) => {},
  autoCompleteAnalysis: async (..._args: unknown[]) => {},
  reset() {
    this.triggerAnalysisByStravaId = async (..._args: unknown[]) => {};
    this.autoCompleteAnalysis = async (..._args: unknown[]) => {};
  },
};

mock.module("../src/services/analysis_service.ts", () => {
  class ResumeValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ResumeValidationError";
    }
  }
  class NoPendingInterruptError extends ResumeValidationError {
    constructor(message: string) {
      super(message);
      this.name = "NoPendingInterruptError";
    }
  }
  return {
    ResumeValidationError,
    NoPendingInterruptError,
    startAnalysis: async () => {},
    resumeAnalysis: async () => {},
    autoCompleteAnalysis: (...args: unknown[]) =>
      analysisServiceMock.autoCompleteAnalysis(...args),
    triggerAnalysisByStravaId: (...args: unknown[]) =>
      analysisServiceMock.triggerAnalysisByStravaId(...args),
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
  applyPaceProgression: (sets: unknown) => sets,
  easePace: (mps: number | null | undefined) => mps ?? null,
  applyReadinessAdjustment: (basePaces: unknown) => ({
    paces: basePaces,
    penaltySecPerKm: 0,
    advisory: "",
  }),
}));

// Mutable delegate: the suggest-session LLM seam. Defaults to a no-op that
// returns null (service then uses the athlete's own structure). A test file may
// swap the delegate and read `calls` to assert the LLM was / wasn't invoked —
// call reset() when done (global across files).
export const suggestSessionAgentMock = {
  calls: 0,
  invoke: async (..._args: unknown[]): Promise<unknown> => null,
  reset() {
    this.calls = 0;
    this.invoke = async () => null;
  },
};

mock.module("../src/agent/suggest_session_agent.ts", () => ({
  suggestSessionOutput: z.object({ structure: z.array(z.unknown()) }),
  invokeSuggestSessionAgent: (...args: unknown[]) => {
    suggestSessionAgentMock.calls++;
    return suggestSessionAgentMock.invoke(...args);
  },
}));

mock.module("../src/services/lap_derivation_service.ts", () => ({
  getSegmentsForActivity: async () => [],
  matchLapsToExpandedSteps: () => [],
  structureShapeMatches: () => false,
  buildSegmentsFromLaps: () => null,
}));

mock.module("../src/agent/parse_intervals_agent.ts", () => ({
  parseWorkoutStep: z.object({ target_pace_string: z.string().nullable().optional() }),
  parseWorkoutSet: z.object({ steps: z.array(z.unknown()) }),
  parseIntervalsOutput: z.object({ sets: z.array(z.unknown()) }),
  invokeParseIntervalsAgent: async () => ({ sets: [] }),
}));

// Training coach graph: the real graph calls OpenAI + a Postgres checkpointer.
// Stub `buildTrainingGraph` to a fake compiled graph. Mutable delegates let a
// test file drive the streamed answer or force an error/abort — call reset()
// when done (the mock is global across files).
type StreamEvent = [string, unknown];
async function* defaultStream(): AsyncGenerator<StreamEvent> {
  yield ["values", { finalAnswer: "Here is your training answer.", pendingArtifacts: null }];
}
export const trainingGraphMock = {
  stream: defaultStream as (...args: unknown[]) => AsyncGenerator<StreamEvent>,
  getState: (async () => ({ values: { messages: [] } })) as (...args: unknown[]) => Promise<unknown>,
  updateState: (async () => {}) as (...args: unknown[]) => Promise<unknown>,
  reset() {
    this.stream = defaultStream;
    this.getState = async () => ({ values: { messages: [] } });
    this.updateState = async () => {};
  },
};

mock.module("../src/agent/training/training_graph.ts", () => ({
  buildTrainingGraph: async () => ({
    stream: (...args: unknown[]) => trainingGraphMock.stream(...args),
    getState: (...args: unknown[]) => trainingGraphMock.getState(...args),
    updateState: (...args: unknown[]) => trainingGraphMock.updateState(...args),
  }),
}));

// Chat coach-thread deletion: the real helper builds a Postgres checkpointer.
// Stub it so DELETE can assert the thread was dropped without a live
// checkpointer (and without mocking the whole analysis graph, which the
// real-graph tests need). Mutable delegate — call reset() when done.
export const checkpointerMock = {
  deletedThreads: [] as string[],
  deleteCoachThread: (async () => {}) as (conversationId: string) => Promise<void>,
  reset() {
    this.deletedThreads = [];
    this.deleteCoachThread = async () => {};
  },
};

mock.module("../src/agent/chat_thread.ts", () => ({
  deleteCoachThread: (conversationId: string) => {
    checkpointerMock.deletedThreads.push(conversationId);
    return checkpointerMock.deleteCoachThread(conversationId);
  },
}));

// Chat title generation: the real helper calls the LLM. Stub it so the first
// clean turn deterministically upgrades the title. Mutable delegate — a test
// may swap it (e.g. to fail) and MUST call reset() when done.
export const chatTitleMock = {
  generateConversationTitle: (async () => "AI generated title") as (
    question: string,
    answer: string,
  ) => Promise<string | null>,
  reset() {
    this.generateConversationTitle = async () => "AI generated title";
  },
};

mock.module("../src/agent/chat_title.ts", () => ({
  generateConversationTitle: (question: string, answer: string) =>
    chatTitleMock.generateConversationTitle(question, answer),
}));

// Better Auth OTP delivery: capture instead of sending (Resend would 401 with
// the dummy key anyway). The dual-auth guard tests read the captured code to
// complete the sign-in flow.
export const otpCapture = { last: null as { email: string; otp: string } | null };

mock.module("../src/services/auth_email.ts", () => ({
  sendSignInOtpEmail: async (email: string, otp: string) => {
    otpCapture.last = { email, otp };
  },
}));
