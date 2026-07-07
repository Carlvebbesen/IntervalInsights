import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getIntervalsAccessToken } from "../src/middlewares/intervals_middleware";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import { INTERVALS_TOKEN_URL } from "../src/routers/intervals/intervals_oauth_config";
import { clerkUsersMock } from "./setup";

const NOW = Math.floor(Date.now() / 1000);
const EXPIRED = NOW - 100;
const FUTURE = NOW + 86_400;
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

const realFetch = globalThis.fetch;

type StoredMetadata = Record<string, unknown>;

// Simulates Clerk + the provider token endpoints. The provider ROTATES the
// refresh token on use and invalidates the old one — the failure mode the
// single-flight guard exists for.
const makeHarness = () => {
  const state = {
    metadata: {
      strava: {
        access_token: "old-strava",
        refresh_token: "strava-refresh-1",
        expires_at: EXPIRED,
        athlete_id: 1,
      },
      intervals: {
        access_token: "old-intervals",
        refresh_token: "intervals-refresh-1",
        expires_at: EXPIRED,
        athlete_id: "i1",
      },
    } as StoredMetadata,
    metadataWrites: 0,
    stravaRefreshCalls: [] as string[],
    intervalsRefreshCalls: [] as string[],
    validStravaRefresh: "strava-refresh-1",
    validIntervalsRefresh: "intervals-refresh-1",
    failMetadataWrite: false,
  };

  clerkUsersMock.getUser = async () => ({
    privateMetadata: state.metadata,
    publicMetadata: {},
  });
  clerkUsersMock.updateUserMetadata = async (_userId, params) => {
    if (state.failMetadataWrite) throw new Error("clerk metadata write failed");
    state.metadataWrites += 1;
    const { privateMetadata } = params as { privateMetadata: StoredMetadata };
    state.metadata = { ...state.metadata, ...privateMetadata };
    return {};
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

let userCounter = 0;
const freshUserId = () => `user_refresh_test_${++userCounter}`;

describe("OAuth token refresh single-flight", () => {
  let state: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    state = makeHarness();
  });

  afterEach(() => {
    clerkUsersMock.reset();
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    clerkUsersMock.reset();
    globalThis.fetch = realFetch;
  });

  it("N concurrent Strava requests with an expired token trigger exactly one refresh", async () => {
    const clerkUserId = freshUserId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getStravaAccessTokens(clerkUserId)),
    );

    expect(state.stravaRefreshCalls).toEqual(["strava-refresh-1"]);
    expect(state.metadataWrites).toBe(1);
    for (const tokens of results) {
      expect(tokens.access_token).toBe("new-strava");
      expect(tokens.refresh_token).toBe("strava-refresh-2");
    }
  });

  it("N concurrent intervals requests with an expired token trigger exactly one refresh", async () => {
    const clerkUserId = freshUserId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getIntervalsAccessToken(clerkUserId)),
    );

    expect(state.intervalsRefreshCalls).toEqual(["intervals-refresh-1"]);
    expect(state.metadataWrites).toBe(1);
    for (const token of results) {
      expect(token).toBe("new-intervals");
    }
  });

  it("a later call reads the persisted tokens and does not refresh again", async () => {
    const clerkUserId = freshUserId();
    await getStravaAccessTokens(clerkUserId);
    const second = await getStravaAccessTokens(clerkUserId);

    expect(state.stravaRefreshCalls).toHaveLength(1);
    expect(second.access_token).toBe("new-strava");
  });

  it("does not hand back a refreshed token when the metadata write fails", async () => {
    const clerkUserId = freshUserId();
    state.failMetadataWrite = true;

    await expect(getStravaAccessTokens(clerkUserId)).rejects.toThrow(
      "clerk metadata write failed",
    );
  });

  it("keeps flights isolated per user", async () => {
    const results = await Promise.allSettled([
      getStravaAccessTokens(freshUserId()),
      getStravaAccessTokens(freshUserId()),
    ]);

    // Two users → two refresh POSTs (not shared). Both read the same stored
    // refresh token concurrently, so after the winner rotates it the loser's
    // POST is rejected by the provider — one fulfilled, one 401.
    expect(state.stravaRefreshCalls).toHaveLength(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("throws 403 when the provider is not linked", async () => {
    state.metadata = {};

    const toError = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { status?: number; details?: unknown }) => e,
      );

    const stravaErr = await toError(getStravaAccessTokens(freshUserId()));
    expect(stravaErr?.status).toBe(403);
    expect(stravaErr?.details).toBe("Strava account not linked");

    const intervalsErr = await toError(getIntervalsAccessToken(freshUserId()));
    expect(intervalsErr?.status).toBe(403);
    expect(intervalsErr?.details).toBe("Intervals.icu account not linked");
  });
});
