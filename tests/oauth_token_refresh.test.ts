import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { getIntervalsAccessToken } from "../src/middlewares/intervals_middleware";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import { INTERVALS_TOKEN_URL } from "../src/routers/intervals/intervals_oauth_config";
import * as tokenStore from "../src/services/oauth_token_store";
import { closePool, createTestUser, deleteTestUser, getDb, purgeOrphanedTestUsers } from "./helpers/db";

const NOW = Math.floor(Date.now() / 1000);
const EXPIRED = NOW - 100;
const FUTURE = NOW + 86_400;
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

const realFetch = globalThis.fetch;

// Simulates the provider token endpoints. The provider ROTATES the refresh token
// on use and invalidates the old one — the failure mode the single-flight guard
// exists for. The token vault itself is the real Postgres `oauth_provider_tokens`
// table (encrypted at rest), seeded per test.
const makeFetchHarness = () => {
  const state = {
    stravaRefreshCalls: [] as string[],
    intervalsRefreshCalls: [] as string[],
    validStravaRefresh: "strava-refresh-1",
    validIntervalsRefresh: "intervals-refresh-1",
  };

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url === STRAVA_TOKEN_URL) {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      state.stravaRefreshCalls.push(body.refresh_token);
      if (body.refresh_token !== state.validStravaRefresh) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      }
      state.validStravaRefresh = "strava-refresh-2";
      return Response.json({
        token_type: "Bearer",
        access_token: "new-strava",
        expires_at: FUTURE,
        expires_in: 86_400,
        refresh_token: "strava-refresh-2",
      });
    }
    if (url === INTERVALS_TOKEN_URL) {
      const body = init?.body as URLSearchParams;
      const refreshToken = body.get("refresh_token") ?? "";
      state.intervalsRefreshCalls.push(refreshToken);
      if (refreshToken !== state.validIntervalsRefresh) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      }
      state.validIntervalsRefresh = "intervals-refresh-2";
      return Response.json({
        access_token: "new-intervals",
        refresh_token: "intervals-refresh-2",
        expires_in: 86_400,
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  return state;
};

const createdUserIds: string[] = [];

/** Create a user with an EXPIRED token for each provider (known refresh values). */
async function seedExpiredUser() {
  const user = await createTestUser({ strava: false, intervals: false });
  createdUserIds.push(user.id);
  const db = getDb();
  await tokenStore.writeProviderToken(db, user.id, "strava", {
    access_token: "old-strava",
    refresh_token: "strava-refresh-1",
    expires_at: EXPIRED,
    athlete_id: "1",
  });
  await tokenStore.writeProviderToken(db, user.id, "intervals", {
    access_token: "old-intervals",
    refresh_token: "intervals-refresh-1",
    expires_at: EXPIRED,
    athlete_id: "i1",
  });
  return user;
}

describe("OAuth token refresh single-flight", () => {
  let state: ReturnType<typeof makeFetchHarness>;

  const startHarness = () => {
    state = makeFetchHarness();
  };

  afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const id of createdUserIds.splice(0)) await deleteTestUser(id);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await purgeOrphanedTestUsers();
    await closePool();
  });

  it("N concurrent Strava requests with an expired token trigger exactly one refresh", async () => {
    startHarness();
    const user = await seedExpiredUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getStravaAccessTokens(user.id)),
    );

    expect(state.stravaRefreshCalls).toEqual(["strava-refresh-1"]);
    for (const tokens of results) {
      expect(tokens.access_token).toBe("new-strava");
      expect(tokens.refresh_token).toBe("strava-refresh-2");
    }
    const stored = await tokenStore.readProviderToken(getDb(), user.id, "strava");
    expect(stored?.access_token).toBe("new-strava");
    expect(stored?.refresh_token).toBe("strava-refresh-2");
  });

  it("N concurrent intervals requests with an expired token trigger exactly one refresh", async () => {
    startHarness();
    const user = await seedExpiredUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getIntervalsAccessToken(user.id)),
    );

    expect(state.intervalsRefreshCalls).toEqual(["intervals-refresh-1"]);
    for (const token of results) {
      expect(token).toBe("new-intervals");
    }
    const stored = await tokenStore.readProviderToken(getDb(), user.id, "intervals");
    expect(stored?.access_token).toBe("new-intervals");
  });

  it("a later call reads the persisted tokens and does not refresh again", async () => {
    startHarness();
    const user = await seedExpiredUser();
    await getStravaAccessTokens(user.id);
    const second = await getStravaAccessTokens(user.id);

    expect(state.stravaRefreshCalls).toHaveLength(1);
    expect(second.access_token).toBe("new-strava");
  });

  it("does not persist or hand back a refreshed token when the DB write fails", async () => {
    startHarness();
    const user = await seedExpiredUser();
    const spy = spyOn(tokenStore, "writeProviderToken").mockRejectedValueOnce(
      new Error("db write failed"),
    );

    await expect(getStravaAccessTokens(user.id)).rejects.toThrow("db write failed");
    spy.mockRestore();

    const stored = await tokenStore.readProviderToken(getDb(), user.id, "strava");
    expect(stored?.access_token).toBe("old-strava");
  });

  it("keeps flights isolated per user", async () => {
    startHarness();
    const u1 = await seedExpiredUser();
    const u2 = await seedExpiredUser();
    const results = await Promise.allSettled([
      getStravaAccessTokens(u1.id),
      getStravaAccessTokens(u2.id),
    ]);

    // Two users → two refresh POSTs (not shared). Both read the same stored
    // refresh token concurrently, so after the winner rotates it the loser's
    // POST is rejected by the provider — one fulfilled, one 401.
    expect(state.stravaRefreshCalls).toHaveLength(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("throws 403 when the provider is not linked", async () => {
    startHarness();
    const user = await createTestUser({ strava: false, intervals: false });
    createdUserIds.push(user.id);

    const toError = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { status?: number; details?: unknown }) => e,
      );

    const stravaErr = await toError(getStravaAccessTokens(user.id));
    expect(stravaErr?.status).toBe(403);
    expect(stravaErr?.details).toBe("Strava account not linked");

    const intervalsErr = await toError(getIntervalsAccessToken(user.id));
    expect(intervalsErr?.status).toBe(403);
    expect(intervalsErr?.details).toBe("Intervals.icu account not linked");
  });
});
