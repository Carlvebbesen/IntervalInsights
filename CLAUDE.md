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

TypeScript check (no dedicated test suite):
```bash
npx tsc --noEmit
```
All errors from `node_modules/` are pre-existing third-party issues — only care about `src/` errors.

## Architecture

**Runtime:** Bun + Hono. The entry point is `src/index.ts`, which mounts all routers under `/api/*`.

**Auth flow:**
1. `clerkMiddleware` + `authGuard` (`src/middlewares/auth_middleware.ts`) run on all `/api/*` routes. They resolve `clerkUserId` + internal `userId` (UUID) from a Postgres `users` table, cached in Clerk session claims.
2. `stravaMiddleware` (`src/middlewares/strava_middleware.ts`) is applied per-router on routes that need Strava API access. It reads/refreshes Strava OAuth tokens stored in Clerk **private metadata** and sets `stravaAccessToken` + `stravaAthleteId` on the Hono context.

**Two Hono environment types:**
- `TGlobalEnv` — standard auth only (`userId`, `clerkUserId`)
- `TStravaEnv` — extends `TGlobalEnv` with `stravaAccessToken`, `stravaAthleteId`

Routers that need Strava API access must use `TStravaEnv` and apply `stravaMiddleware`.

**Routers:**
- `GET/POST /api/activity` — activity list, update metadata (`TGlobalEnv`)
- `GET /api/activity/:id/*` (laps, splits, heartrate, segments) — Strava data endpoints (`TStravaEnv`)
- `GET/POST /api/agents` — trigger LLM analysis pipelines (`TStravaEnv`)
- `GET /api/strava/auth/*` — OAuth exchange
- `GET /api/strava/sync/*` — bulk import from Strava
- `GET /api/strava/webhook/*` — manage Strava push subscriptions
- `GET /api/dashboard`, `GET /api/interval-structures` — stats/filter helpers
- `GET/POST /api/strava/event`, `GET /api/health` — public (no auth)
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
- `users` — maps Clerk user IDs to internal UUIDs

**Analysis pipeline** (`src/agent/analysis_graph.ts` — LangGraph with Postgres checkpointer):
Every activity flows through a single graph, paused mid-way for user confirmation. Nodes:
1. `fetchActivityContext` — Strava activity + streams (+ laps when outdoor). Sets `analysisStatus = 'ongoing_init'`.
2. `maybeEnrichWithIntervalsIcu` — if the user has connected intervals.icu (`users.intervalsAthleteId != null`), polls up to 45s for both `activities.intervalsIcuId` and `intervalsAnalyzed`. When ready, fetches the predicted intervals + meta and attaches them to graph state.
3. `runInitialAgent` — calls `invokeActivityAnalysisAgent` (GPT-4o-mini) with all context including the intervals.icu prediction block. Computes `lapsMatchStructure`. Persists everything into `draftAnalysisResult` JSON. Sets `analysisStatus = 'initial'`.
4. `awaitUserInput` — `interrupt()` pauses the graph. Frontend submits training type, notes, sets, and optional `feeling` via `POST /api/agents/resume-analysis`.
5. `runCompleteAnalysis` — for interval training types only, calls `invokeCompleteActivityAnalysisAgent` to produce per-segment data. Skipped for EASY/LONG/RECOVERY/RACE/OTHER. Sets `analysisStatus = 'ongoing_completed'`.
6. `validateSignature` — exact + Jaccard 0.7 fuzzy match against the user's existing `interval_structures`.
7. `persistResults` — writes `interval_segments` (if any), links activity to `intervalStructureId`, flips status to `completed`. Always runs even when no segments — single source of truth for completion.
8. `detectEvents` — always runs at the tail. `invokeEventDetectionAgent` extracts injuries/illnesses from title/description/notes.

`analysisStatus` lifecycle: `pending` → `ongoing_init` → `initial` (paused, awaiting user) → `ongoing_completed` → `completed`. Plus `error` and `skipped_inactive` terminal/recoverable states.

**Inactivity gate** (`process_strava_event.ts`): reads `lastSignInAt` from Clerk. If user inactive > 90d, drops the Strava activity entirely. If 14–90d inactive, inserts with `analysisStatus = 'skipped_inactive'` (no LLM calls). `GET /api/agents/pending` re-queues these on next pending fetch.

**Auto-retry for errors**: `error` activities with `analysisAttemptCount < 2` are retried automatically by `/pending`. After two failures the user must manually retry.

**Idempotency**: `startAnalysis` and `restartAnalysisByStravaId` skip activities already in `{ongoing_init, ongoing_completed, initial, completed, skipped_inactive}`. GET endpoints NEVER trigger analysis.

**Agents** (`src/agent/`):
- `initial_analysis_agent.ts` — classify + draft structure, with optional intervals.icu prediction block.
- `full_analysis_agent.ts` — per-segment time-series breakdown for interval types.
- `event_detection_agent.ts` — extract health events.
- `parse_intervals_agent.ts` — free-text → `workoutSet[]`. Powers `POST /api/agents/parse-intervals`.

**LLM:** GPT-4o-mini via `@langchain/openai`, zero temperature, defined in `src/agent/model.ts`. `invokeWithRateLimitRetry` honours OpenAI's `Retry-After` header with exponential backoff. `ANALYSIS_VERSION` constant tags every analysed activity.

**Strava API service** (`src/services/strava_api_service.ts`): thin wrapper around Strava v3 REST API. All methods accept an `accessToken` — never stored on the service itself.

## API Conventions

**Validation:** every router uses `hono-openapi`'s `validator("json" | "query" | "param", zodSchema)` together with `describeRoute` + `resolver(...)` so request validation and the OpenAPI spec (`/api/docs`) come from the same Zod schemas. Reuse Drizzle enums in schemas (`z.enum(trainingTypeEnum.enumValues)`). Path params are validated with `validator("param", ...)` using a `z.coerce.number()` schema — never parse `c.req.param()` by hand.

**Error responses:** the only error envelope is `{ error: string }` (plus optional `{ details }`). Don't wrap a handler in `try/catch` just to return a 500 — that duplicates `app.onError`. Instead:
- For expected failures (not-found, forbidden, bad input that can't be expressed in the Zod schema), `throw new AppError(status, message, details?)` (`src/error.ts`); `app.onError` renders it. Integration failures use `StravaError` / `IntervalsError`.
- `return c.json({ error }, status)` directly is fine for simple inline control flow (e.g. a 404 after a missing row).

**Success responses:** the legacy endpoints use mixed shapes (bare arrays/objects, `{ success, message }`, `{ data, meta }` pagination wrappers, and `{ status: "ok" | ... }` discriminated unions). These can't be reshaped without breaking live app versions, so existing shapes are frozen. **New** list endpoints should use the `{ data, meta }` wrapper; new mutations should return the affected resource object. Document every response with a `resolver(Schema)` in `describeRoute`.

**Deprecating a route shape:** when a route's path or request shape changes, keep the old route working alongside the new one. Mark the old handler with a `/** @deprecated ... */` JSDoc comment, set `deprecated: true` in its `describeRoute`, and prefix its description with `[DEPRECATED — use <new route>]`. Remove only once all clients have migrated. Example: `POST /api/activity/update` is deprecated in favour of `PATCH /api/activity/:id`.

## Observability (OpenTelemetry → Grafana Cloud)

The app emits OTLP traces, metrics, and logs. `src/instrumentation.ts` initializes the OpenTelemetry Node SDK and is preloaded by `bun --preload` (see the `dev`/`start` scripts). `@hono/otel`'s `httpInstrumentationMiddleware` creates a span per request under `/api/*`, and `authGuard` tags spans with `user.id` / `clerk.user.id` / `user.role`.

Auto-instrumentation covers outgoing `http`, `pg` (Drizzle's driver), and `undici`/`fetch` (outbound Strava + OpenAI). Incoming HTTP spans come from `@hono/otel` (so they carry Hono route paths); the Node `http` server-side instrumentation and `fs` are disabled. Errors handled in `app.onError` record exceptions on the active span.

### Configuration

The SDK only starts when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local dev is silent by default. Set these on Railway (and only there) to ship telemetry:
- `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp`
- `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>`
- `OTEL_DEPLOYMENT_ENVIRONMENT=production`
- `GIT_SHA=$RAILWAY_GIT_COMMIT_SHA` (becomes `service.version`)

## Environment Variables Required

`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` (used to derive the Clerk OAuth/FAPI URL for the MCP server), `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `OPENAI_API_KEY` (for GPT-4o-mini).

Optional OTel: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` (default `intervals-backend`), `OTEL_SERVICE_VERSION` / `GIT_SHA`, `OTEL_DEPLOYMENT_ENVIRONMENT`.

LangChain/LangGraph GenAI tracing (sends `gen_ai.*` spans through the existing OTLP pipeline to Grafana's GenAI view): set both `LANGSMITH_OTEL_ENABLED=true` and `LANGSMITH_TRACING=true`. `src/instrumentation.ts` calls `initializeOTEL({ globalTracerProvider })` so LangSmith reuses the NodeSDK tracer provider — no separate exporter is created.

## Development brain

This repo has a shared knowledge base at `~/Development/development-brain` (the IntervalInsights second brain): architecture notes, ADRs, gotchas, recipes, glossary, and agent messages/handoffs. At task start, use the `brain-recall` skill to check what the brain knows; when a session surfaces durable knowledge (non-obvious fix, decided tradeoff, cross-repo contract with the Flutter app), capture it with `brain-capture`. The brain's rules live in its own `CLAUDE.md`/`CONVENTIONS.md`.
