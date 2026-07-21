# Endpoint tests

These tests exercise every `/api/*` route against a real Postgres instance.
External services (Strava REST, intervals.icu REST, OpenAI/LangGraph) are
mocked via `bun:test`'s `mock.module()` in `tests/setup.ts`, so the tests run
offline and finish in well under a second.

## Running

```bash
# 1. Make sure the local Postgres is up and migrated
docker compose up -d
bun run db:migrate

# 2. Run the tests (uses DATABASE_URL from .env)
bun test

# Optional: point at a dedicated test DB
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/intervals_test bun test
```

`bunfig.toml` preloads `tests/setup.ts`, which:

- Sets safe dummy values for every `requireEnv` call so the routers load.
- Mocks every external service module (`strava_api_service`,
  `intervals_api_service`, `analysis_service`, `intervals_wellness_service`,
  `intervals_link_service`, `pace_service`, `lap_derivation_service`,
  `requeue_service`, `process_strava_event`, `process_intervals_event`,
  `parse_intervals_agent`).
- Mocks `src/services/auth_email.ts` (OTP delivery) into an in-memory capture
  (`otpCapture`) so the auth-guard tests (`better_auth_guard.test.ts`) can
  complete a real Better Auth OTP sign-in.

Provider tokens live in Postgres (`oauth_provider_tokens`) — `createTestUser`
seeds encrypted Strava + Intervals rows by default so the real Strava/Intervals
middlewares pass through (opt out with `{ strava: false }` / `{ intervals: false }`).

## Test architecture

- `tests/helpers/test_app.ts` builds a fresh Hono app that mirrors
  `src/index.ts` but replaces `authGuard` with a test guard that reads identity
  from an `AsyncLocalStorage` populated by `withIdentity()`. The real guard
  (Better Auth bearer session) is exercised by the focused
  `better_auth_guard.test.ts` suite.
- `tests/helpers/db.ts` owns the Postgres pool, plus
  `createTestUser` / `deleteTestUser` helpers. Seeded users get a unique
  `test-user-<uuid>@test.local` email (the column is `NOT NULL UNIQUE`, and the
  prefix is what `purgeOrphanedTestUsers` matches on); cleanup walks cascaded
  children explicitly (the FKs from `users.id` are `ON DELETE NO ACTION`).
- `tests/helpers/fixtures.ts` has tiny factories for activities + events.

## File layout

| File                                 | Endpoints                                      |
| ------------------------------------ | ---------------------------------------------- |
| `public.test.ts`                     | `/api/health`, webhooks, privacy/terms         |
| `user.test.ts`                       | `/api/user`, `/api/admin/users/:id/role`       |
| `activities.test.ts`                 | `/api/activity/*`                              |
| `events.test.ts`                     | `/api/events`                                  |
| `dashboard.test.ts`                  | `/api/dashboard/*`                             |
| `agents.test.ts`                     | `/api/agents/*`                                |
| `strava.test.ts`                     | `/api/strava/auth`, sync, webhook              |
| `intervals.test.ts`                  | `/api/intervals/auth`, `/api/intervals/sync`   |
| `interval_structures.test.ts`        | `/api/interval-structures/filter`              |

## Adding a new endpoint

1. Add the handler to the appropriate router under `src/routers/`.
2. Add a test in the matching `tests/*.test.ts` file.
3. If the endpoint calls a new external service, mock that service module in
   `tests/setup.ts`.
