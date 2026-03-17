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

**Analysis pipeline** (`src/services.ts/analysis_service.ts`):
1. **Initial analysis** (`triggerInitialAnalysis`) — fetches activity streams (velocity, HR, distance), calls `invokeActivityAnalysisAgent` (Gemini Flash via LangChain), classifies `trainingType` and drafts interval structure. If the type doesn't need a detailed breakdown (`couldSkipCompleteAnalysis`), it marks the activity `completed` immediately using `splits_metric` from Strava as segments.
2. **Complete analysis** (`triggerCompleteAnalysis`) — called manually via `POST /api/agents/start-complete-analysis`. Fetches streams + laps, calls `invokeCompleteActivityAnalysisAgent`, and writes precise `interval_segments` with time-series stats.

`analysisStatus` lifecycle: `pending` → `ongoing_init` → `initial` → `ongoing_completed` → `completed` (or `error` at any step).

**LLM:** Gemini 2.5 Flash via `@langchain/google-genai`, zero temperature, defined in `src/agent/model.ts`. Zod schemas define structured outputs for both agents.

**Strava API service** (`src/services.ts/strava_api_service.ts`): thin wrapper around Strava v3 REST API. All methods accept an `accessToken` — never stored on the service itself.

## Environment Variables Required

`DATABASE_URL`, `CLERK_SECRET_KEY`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `GOOGLE_API_KEY` (for Gemini).
