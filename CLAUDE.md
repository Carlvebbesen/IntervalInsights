# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # Start server with hot reload
bun run start        # Start server (production)
bun run build        # Compile to single binary (./server)

bun run db:generate  # Generate Drizzle migrations from schema changes
bun run db:migrate   # Run pending migrations
bun run db:push      # Push schema directly (dev only)
bun run db:studio    # Open Drizzle Studio UI
```

Checks & tests:
```bash
bun run check        # one-shot verify: test suite + tsc --noEmit (src/ only) + biome check src
bun run test         # Endpoint + service suite (spins up a disposable Postgres via Docker)
bun run test:pace    # Pace/readiness unit suite
```
See `tests/README.md` for how the endpoint suite stubs auth and provisions its DB. The type gate covers `src/` only — tests are intentionally type-loose (mocks cast past interfaces), and `node_modules/` errors are pre-existing third-party issues.

## Architecture

**Runtime:** Bun + Hono. The entry point is `src/index.ts`. Public routes mount at `/api`
(before Clerk); all authenticated routers mount under a versioned `/api/v1` sub-app.

**Auth flow (dual-auth window — Better Auth alongside Clerk until the Phase 6 cutover):**
0. **Registration is explicit** (`disableSignUp: true` on the emailOTP plugin): `POST /api/auth/sign-up/email-otp` creates the guest `users` row (name supplied here, `emailVerified: false`); the first OTP verify flips `emailVerified` true. OTP **sign-in** with an unknown email sends no code and creates no account (email-enumeration protection). The store-review demo account is seeded at boot by `ensureReviewAccount()` (`src/auth.ts`, called from `src/index.ts`) rather than auto-created on first verify.
1. `authGuard` (`src/middlewares/auth_middleware.ts`) runs on all `/api/*` routes behind `clerkMiddleware`. It first tries a **Better Auth** bearer session (`auth.api.getSession`; `session.user` IS the full `users` row — see `src/auth.ts`), then falls back to the legacy **Clerk** session (`users` lookup by `clerkId`, lazy-create enriched with verified email/name from Clerk). Both paths resolve `userId` (UUID), `role`, and the full `user` row; `clerkUserId` is `null` for Better Auth-native users. The `users` table is the source of truth for identity/role. The active path is tagged as the `auth.provider` span attribute.
2. `stravaMiddleware` (`src/middlewares/strava_middleware.ts`) is applied per-router on routes that need Strava API access. It reads/refreshes Strava OAuth tokens from the encrypted Postgres vault (`oauth_provider_tokens`, keyed by `users.id`) and sets `stravaAccessToken` + `stravaAthleteId` on the Hono context.

**Two Hono environment types:**
- `TGlobalEnv` — standard auth only (`userId`, nullable `clerkUserId`)
- `TStravaEnv` — extends `TGlobalEnv` with `stravaAccessToken`, `stravaAthleteId`

Routers that need Strava API access must use `TStravaEnv` and apply `stravaMiddleware`.

**Public routes (unversioned, mounted at `/api` before Clerk — external systems pin these):**
- `GET/POST /api/strava/event`, `POST /api/intervals/event` — inbound webhooks
- `GET /api/health` — liveness probe
- `GET /api/privacy-policy`, `GET /api/terms-of-service` — legal markdown
- `POST|GET /api/auth/*` — Better Auth endpoints (email-OTP send/verify, session), handled by `auth.handler`. Includes the custom `POST /api/auth/sign-up/email-otp` plugin (name + email) — the only way to register, since OTP sign-in no longer auto-creates accounts. It is enumeration-safe (identical `{success:true}` for a new or already-registered email)
- Plus the app-root routes `/`, `/app-icon.png`, `/favicon.ico`, `/.well-known/*`, and the MCP router.

**Authenticated routers (mounted under `/api/v1`, behind `clerkMiddleware` + `authGuard`):**
- `/api/v1/activity` — list, detail, `PATCH /:id` metadata, gear, segments, laps, splits, streams, editor-state (`TGlobalEnv` + `TStravaEnv` sub-router)
- `/api/v1/agents` — pending, start/resume analysis, parse-intervals, suggest-session (`TStravaEnv`)
- `/api/v1/strava/auth/*` (OAuth exchange), `/sync/*` (bulk import), `/webhook/*` (push-subscription mgmt — **admin-only**)
- `/api/v1/intervals/*` — intervals.icu OAuth + sync
- `/api/v1/dashboard`, `/api/v1/interval-structures`, `/api/v1/heart-rate/analysis`, `/api/v1/events`, `/api/v1/gear`, `/api/v1/user`, `/api/v1/chat`, `/api/v1/progress` — stats, filters, HR analysis, events, gear, profile, coach chat, SSE progress
- `/api/v1/admin/*` — role management (`requireRole("admin")`)
- `POST /mcp` — remote MCP server for Claude/ChatGPT; OAuth-token auth, **not** under `/api/*` (see MCP section)

**MCP server** (`src/mcp/`, mounted via `src/routers/mcp_router.ts` at the app root):
A remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude/ChatGPT connect to an athlete's own training data as read-only tools. It deliberately sits **outside** the `/api/*` Clerk-session chain:
- **Transport:** `@hono/mcp`'s `StreamableHTTPTransport` (`handleRequest(c)`), stateless — a fresh `McpServer` is built per request. No Node `req/res` bridge needed on Bun.
- **Auth:** `src/mcp/auth.ts` verifies the Clerk-issued **OAuth access token** (`clerkClient.authenticateRequest(c.req.raw, { acceptsToken: 'oauth_token' })` → `verifyClerkToken`), then maps `clerkUserId` → internal user exactly like `authGuard`. A different token type from `/api/*` (session tokens) — same identity resolution. 401s carry a `WWW-Authenticate` header pointing at the protected-resource metadata.
- **OAuth discovery:** Clerk is the Authorization Server. Two public routes serve the metadata: `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728) and `GET /.well-known/oauth-authorization-server` (RFC 8414), via `@clerk/mcp-tools/server`. **Dynamic Client Registration must be toggled on** in the Clerk dashboard (OAuth applications) for Claude/ChatGPT to self-register.
- **Tools:** `src/mcp/server.ts` reuses the coach `registry` (every coach tool is read-only) via `runTool`, gated by `requires` (`db` always; `strava`/`intervals` only when linked). Tools that make their own server-side OpenAI calls (`OPENAI_BACKED_TOOL_NAMES`, currently `parse_workout`) are excluded so external clients can't drive our model spend. The Strava access token is resolved lazily, only when a strava-backed tool is actually called.

**Database (Drizzle + PostgreSQL):** Schema lives in `src/schema/`. Key tables:
- `activities` — one row per Strava activity, stores `analysisStatus`, `trainingType`, `draftAnalysisResult` (JSON), and Strava metadata
- `interval_segments` — per-segment breakdown of a workout (pace, HR, type, target)
- `interval_structures` — deduped workout shapes identified by a `signature` hash; activities with the same structure share a row
- `users` — the app user AND the Better Auth user model (single-table integration): internal UUID `id`, `email`/`email_verified`/`name`/`image`, `role`, provider athlete ids, and a nullable legacy `clerk_id` (dropped in Phase 6)
- `sessions`, `accounts`, `verifications` — Better Auth-managed (server-side sessions, future social providers, OTP storage)
- `oauth_provider_tokens` — encrypted Strava/intervals.icu OAuth tokens, keyed by `users.id`

**Analysis pipeline** (`src/agent/analysis_graph.ts` — LangGraph with Postgres checkpointer):
Every activity flows through a single graph, paused mid-way for user confirmation. Nodes:
1. `fetchActivityContext` — Strava activity + streams (+ laps when outdoor). Sets `analysisStatus = 'ongoing_init'`.
2. `maybeEnrichWithIntervalsIcu` — if the user has connected intervals.icu (`users.intervalsAthleteId != null`), polls up to 45s for both `activities.intervalsIcuId` and `intervalsAnalyzed`. When ready, fetches the predicted intervals + meta and attaches them to graph state.
3. `runInitialAgent` — calls `invokeActivityAnalysisAgent` (GPT-4o-mini) with all context including the intervals.icu prediction block. Computes `lapsMatchStructure`. Persists everything into `draftAnalysisResult` JSON. Sets `analysisStatus = 'initial'`.
4. `awaitUserInput` — `interrupt()` pauses the graph. Frontend submits training type, notes, sets, and optional `feeling` via `POST /api/v1/agents/resume-analysis`.
5. `runCompleteAnalysis` — for interval training types only, calls `invokeCompleteActivityAnalysisAgent` to produce per-segment data. Skipped for EASY/LONG/RECOVERY/RACE/OTHER. Sets `analysisStatus = 'ongoing_completed'`.
6. `validateSignature` — exact + Jaccard 0.7 fuzzy match against the user's existing `interval_structures`.
7. `persistResults` — writes `interval_segments` (if any), links activity to `intervalStructureId`, flips status to `completed`. Always runs even when no segments — single source of truth for completion.
8. `detectEvents` — always runs at the tail. `invokeEventDetectionAgent` extracts injuries/illnesses from title/description/notes.

`analysisStatus` lifecycle: `pending` → `ongoing_init` → `initial` (paused, awaiting user) → `ongoing_completed` → `completed`. Plus `error` and `skipped_inactive` terminal/recoverable states.

**Inactivity gate** (`process_strava_event.ts`): reads `users.lastSeenAt` (bumped by `authGuard`, at most hourly). If user inactive > 90d, drops the Strava activity entirely. If 60–90d inactive, inserts with `analysisStatus = 'skipped_inactive'` (no LLM calls). `GET /api/v1/agents/pending` re-queues these on next pending fetch.

**Auto-retry for errors**: `error` activities with `analysisAttemptCount < 2` are retried automatically by `/pending`. After two failures the user must manually retry.

**Idempotency**: `startAnalysis` and `restartAnalysisByStravaId` skip activities already in `{ongoing_init, ongoing_completed, initial, completed, skipped_inactive}`. GET endpoints NEVER trigger analysis.

**Agents** (`src/agent/`):
- `initial_analysis_agent.ts` — classify + draft structure, with optional intervals.icu prediction block.
- `full_analysis_agent.ts` — per-segment time-series breakdown for interval types.
- `event_detection_agent.ts` — extract health events.
- `parse_intervals_agent.ts` — free-text → `workoutSet[]`. Powers `POST /api/v1/agents/parse-intervals`.

**LLM:** GPT-4o-mini via `@langchain/openai`, zero temperature, defined in `src/agent/model.ts`. `invokeWithRateLimitRetry` honours OpenAI's `Retry-After` header with exponential backoff. `ANALYSIS_VERSION` constant tags every analysed activity.

**Strava API service** (`src/services/strava_api_service.ts`): thin wrapper around Strava v3 REST API. All methods accept an `accessToken` — never stored on the service itself.

## API Conventions

**Validation:** every router uses `hono-openapi`'s `validator("json" | "query" | "param", zodSchema)` together with `describeRoute` + `resolver(...)` so request validation and the OpenAPI spec (`/api/docs`) come from the same Zod schemas. Reuse Drizzle enums in schemas (`z.enum(trainingTypeEnum.enumValues)`). Path params are validated with `validator("param", ...)` using a `z.coerce.number()` schema — never parse `c.req.param()` by hand.

**Error responses:** the only error envelope is `{ error: string }` (plus optional `{ details }`). Don't wrap a handler in `try/catch` just to return a 500 — that duplicates `app.onError`. Instead:
- For expected failures (not-found, forbidden, bad input that can't be expressed in the Zod schema), `throw new AppError(status, message, details?)` (`src/error.ts`); `app.onError` renders it. Integration failures use `StravaError` / `IntervalsError`.
- `return c.json({ error }, status)` directly is fine for simple inline control flow (e.g. a 404 after a missing row).

**Success responses:** endpoints use mixed shapes (bare arrays/objects, `{ success, message }`, `{ data, meta }` pagination wrappers, and `{ status: "ok" | ... }` discriminated unions). **New** list endpoints should use the `{ data, meta }` wrapper; new mutations should return the affected resource object. Document every response with a `resolver(Schema)` in `describeRoute`.

**Versioning & breaking changes:** all clients ship on the latest release — there is no fleet of pinned old app versions to keep alive. Breaking changes (path, request, or response shape) are therefore allowed **within `v1`** as long as the backend and the Flutter app land in the **same release train**. Just change the route in place; don't keep a deprecated twin around. Only when we deliberately need two divergent generations of an endpoint live at once do we cut a new version prefix: add a `v2` sub-app in `src/index.ts` that cherry-picks the routers that changed (unchanged routers stay served from `v1`). The unversioned public routes (`/api/strava/event`, `/api/intervals/event`, `/api/health`, legal) are pinned by external systems and must stay put.

## Observability (OpenTelemetry → Grafana Cloud)

The app emits OTLP traces, metrics, and logs. `src/instrumentation.ts` initializes the OpenTelemetry Node SDK and is preloaded by `bun --preload` (see the `dev`/`start` scripts). `@hono/otel`'s `httpInstrumentationMiddleware` creates a span per request under `/api/*`, and `authGuard` tags spans with `user.id` / `clerk.user.id` / `user.role`.

Auto-instrumentation covers outgoing `http`, `pg` (Drizzle's driver), and `undici`/`fetch` (outbound Strava + OpenAI). Incoming HTTP spans come from `@hono/otel` (so they carry Hono route paths); the Node `http` server-side instrumentation and `fs` are disabled. Errors handled in `app.onError` record exceptions on the active span.

### Configuration

The SDK only starts when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local dev is silent by default. Set these on Railway (and only there) to ship telemetry:
- `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp`
- `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>`
- `OTEL_DEPLOYMENT_ENVIRONMENT=production`
- `GIT_SHA=$RAILWAY_GIT_COMMIT_SHA` (becomes `service.version`)

## API-abuse hardening

Layered deterrence against non-app clients using the backend as a free API. MCP (`/mcp`, OAuth tokens, outside `/api/*`) is the sanctioned external door and is exempt from all of this.

**Tier 1a — Better Auth's built-in IP rate limiter.** We rely on the defaults (no `rateLimit` block in `src/auth.ts`). Verified against `better-auth@1.6.23` (`dist/context/create-context.mjs`, `dist/api/rate-limiter/index.mjs`):
- **Enabled in production only** (`enabled ?? isProduction`) — silent in dev/`test`. In-memory `memory` store (fine on single-instance Railway; if it ever goes multi-instance, set `rateLimit.storage: "database"`).
- Global default **100 requests / 10 s per IP** (window `10`, max `100`).
- Special rule for `/sign-in*`, `/sign-up*`, `/change-password*`, `/change-email*`: **3 / 10 s**.
- emailOTP `/email-otp/send-verification-otp` (and other OTP send/reset paths): **3 / 60 s**. The app's resend cooldown is 20 s, so a real user never trips it.

**Tier 1b — per-user daily quotas on LLM-backed endpoints** (`src/middlewares/quota_middleware.ts`, always on, in-memory per UTC day). Generous by design — a real user never hits them; the analysis cap is a circuit breaker against scripted model spend:
- `POST /api/v1/agents/suggest-session` — 100/user/day (429 over cap)
- `POST /api/v1/agents/parse-intervals` — 100/user/day (429)
- Analysis starts — 1000/user/day, shared bucket across `/start-analysis`, `/resume-analysis` (429), the Strava import fan-out (`strava_api_router.ts` callback) and requeue retries (`requeue_service.ts`) — the last two are background, so they skip-and-warn rather than 429. A batch import of N ids counts N against the cap but is still one request. Webhook auto-analysis (`startAnalysisByStravaId`) is not counted. A warn fires as a user crosses 80%.

**Tier 2 — app client key** (`src/middlewares/client_key_middleware.ts`, `clientKeyGuard`). Deterrence-only (Clerk-publishable-key pattern): the app sends a shared secret as `x-client-key`; nothing here proves app origin (only device attestation could). Mounted on `/api/*` in `src/index.ts` **after** the public routes (so webhooks/health/legal, whose handlers terminate the chain, stay open) and **before** the Better Auth handler (so OTP send/verify is gated too). Controlled by `APP_CLIENT_KEY` / `APP_CLIENT_KEY_MODE` (see env section): unset ⇒ off; `log` ⇒ warn-and-pass (the rollout phase, while already-installed builds send no header); `enforce` ⇒ 401. Do **not** flip to `enforce` until the app release that sends the header is live (and ideally the Phase 6 cutover) — enforcing early bricks every installed build.

Tier 3 (device attestation / OTP-send captcha) stays a documented contingency, triggered by observed abuse in Grafana (OTP-send volume, per-user analysis-start counts, client-key warn rate), not scheduled work.

## Environment Variables Required

`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` (used to derive the Clerk OAuth/FAPI URL for the MCP server), `BETTER_AUTH_SECRET` (min 32 chars, session signing), `BETTER_AUTH_URL` (backend base URL), `RESEND_API_KEY` (OTP email delivery; emails only send in production — dev logs the code), `TOKEN_ENC_KEY` (min 32 chars, provider-token encryption at rest — rotating it invalidates every stored Strava/intervals token), `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `OPENAI_API_KEY` (for GPT-4o-mini). See `src/config.ts` for the full validated set.

Optional store-review demo account: `REVIEW_ACCOUNT_EMAIL` + `REVIEW_ACCOUNT_OTP` (a fixed 6-digit sign-in code for app-store reviewers; both-or-neither, disabled when unset). The review address' OTP email is suppressed — the code lives only in the env. See `src/auth.ts`.

Optional app client key (API-abuse hardening, see below): `APP_CLIENT_KEY` (min 16 chars; unset ⇒ feature off) + `APP_CLIENT_KEY_MODE` (`log` default | `enforce`). See `src/middlewares/client_key_middleware.ts`.

Optional OTel: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` (default `intervals-backend`), `OTEL_SERVICE_VERSION` / `GIT_SHA`, `OTEL_DEPLOYMENT_ENVIRONMENT`.

LangChain/LangGraph GenAI tracing (sends `gen_ai.*` spans through the existing OTLP pipeline to Grafana's GenAI view): set both `LANGSMITH_OTEL_ENABLED=true` and `LANGSMITH_TRACING=true`. `src/instrumentation.ts` calls `initializeOTEL({ globalTracerProvider })` so LangSmith reuses the NodeSDK tracer provider — no separate exporter is created.

## Development brain

This repo has a shared knowledge base at `~/Development/development-brain` (the IntervalInsights second brain): architecture notes, ADRs, gotchas, recipes, glossary, and agent messages/handoffs. At task start, use the `brain-recall` skill to check what the brain knows; when a session surfaces durable knowledge (non-obvious fix, decided tradeoff, cross-repo contract with the Flutter app), capture it with `brain-capture`. The brain's rules live in its own `CLAUDE.md`/`CONVENTIONS.md`.
