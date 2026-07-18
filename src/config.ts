import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    CLERK_SECRET_KEY: z.string().min(1),
    CLERK_PUBLISHABLE_KEY: z.string().min(1),
    OPENAI_API_KEY: z.string().min(1),
    PLAN_BUILDER_MODEL: z.string().min(1).optional(),

    TOKEN_ENC_KEY: z.string().min(32),

    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    RESEND_API_KEY: z.string().min(1).optional(),

    REVIEW_ACCOUNT_EMAIL: z.string().email().toLowerCase().optional(),
    REVIEW_ACCOUNT_OTP: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),

    APP_CLIENT_KEY: z.string().min(16).optional(),
    APP_CLIENT_KEY_MODE: z.enum(["log", "enforce"]).default("log"),

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

    STRAVA_CLIENT_ID: z.string().min(1),
    STRAVA_CLIENT_SECRET: z.string().min(1),
    STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
    STRAVA_SUBSCRIPTION_ID: z.string().min(1),

    INTERVALS_CLIENT_ID: z.string().min(1),
    INTERVALS_CLIENT_SECRET: z.string().min(1),
    INTERVALS_WEBHOOK_SECRET: z.string().min(1),

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
  })
  .refine((env) => env.NODE_ENV !== "production" || !!env.RESEND_API_KEY, {
    path: ["RESEND_API_KEY"],
    message: "RESEND_API_KEY is required in production",
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
