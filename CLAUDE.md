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

**Strava API service** (`src/services.ts/strava_api_service.ts`): thin wrapper around Strava v3 REST API. All methods accept an `accessToken` — never stored on the service itself.

## Environment Variables Required

`DATABASE_URL`, `CLERK_SECRET_KEY`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `OPENAI_API_KEY` (for GPT-4o-mini).
