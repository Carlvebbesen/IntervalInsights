import { z } from "zod";

/**
 * Central, validated environment configuration. Parsed once at startup — the
 * first import of `config` fails fast with an aggregated error listing every
 * missing/invalid variable, instead of surfacing `undefined` deep in a request.
 *
 * Optional telemetry vars are intentionally left optional so local dev stays
 * silent (see `instrumentation.ts`, which reads OTel vars directly off
 * `process.env` because it is preloaded before this module).
 */
const envSchema = z
  .object({
    // Core
    DATABASE_URL: z.string().min(1),
    CLERK_SECRET_KEY: z.string().min(1),
    CLERK_PUBLISHABLE_KEY: z.string().min(1),
    OPENAI_API_KEY: z.string().min(1),

    // Symmetric key for encrypting provider OAuth tokens at rest
    // (better-auth/crypto). Railway secret; keep stable — rotating it makes every
    // stored Strava/intervals.icu token undecryptable (users re-link).
    TOKEN_ENC_KEY: z.string().min(32),

    // Better Auth (dual-auth window; CLERK_* stay required until the Phase 6 cutover)
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    RESEND_API_KEY: z.string().min(1),

    // Store-review demo account: a fixed sign-in OTP for app-store reviewers who
    // can't read our email inbox. Both-or-neither; the feature is disabled when
    // unset (today's prod). See src/auth.ts for the override.
    REVIEW_ACCOUNT_EMAIL: z.string().email().toLowerCase().optional(),
    REVIEW_ACCOUNT_OTP: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),

    // App
    APP_BASE_URL: z.string().url(),
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.string().optional(),
    PROGRESS_HEARTBEAT_MS: z.coerce.number().default(25000),
    BRAIN_DIR: z.string().optional(),
    MCP_ENFORCE_AUDIENCE: z
      .string()
      .optional()
      .transform((v) => v === "true"),

    // Strava integration
    STRAVA_CLIENT_ID: z.string().min(1),
    STRAVA_CLIENT_SECRET: z.string().min(1),
    STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
    STRAVA_SUBSCRIPTION_ID: z.string().min(1),

    // Intervals.icu integration
    INTERVALS_CLIENT_ID: z.string().min(1),
    INTERVALS_CLIENT_SECRET: z.string().min(1),
    INTERVALS_WEBHOOK_SECRET: z.string().min(1),

    // OpenTelemetry / tracing (optional — only shipped when the endpoint is set)
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().default("intervals-backend"),
    OTEL_SERVICE_VERSION: z.string().optional(),
    OTEL_DEPLOYMENT_ENVIRONMENT: z.string().optional(),
    GIT_SHA: z.string().optional(),
    LANGSMITH_OTEL_ENABLED: z.string().optional(),
    LANGSMITH_TRACING: z.string().optional(),
  })
  .refine((env) => !!env.REVIEW_ACCOUNT_EMAIL === !!env.REVIEW_ACCOUNT_OTP, {
    message: "REVIEW_ACCOUNT_EMAIL and REVIEW_ACCOUNT_OTP must be set together",
  });

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
