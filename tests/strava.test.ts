import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

// Webhook subscription management is admin-only (it manages the app-wide push sub).
const adminIdentity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "admin" as const,
});

/** Replace global fetch for one test. Any URL is captured and a stub response returned. */
function stubFetch(handler: (input: Request | URL | string) => Response) {
  globalThis.fetch = (async (input: Request | URL | string) =>
    handler(input)) as typeof globalThis.fetch;
}

describe("/api/strava/auth", () => {
  it("GET /url returns a Strava authorization URL", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/strava/auth/url"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain("strava.com/oauth/mobile/authorize");
    }));

  it("POST /exchange handles Strava token-exchange success", () =>
    withIdentity(identity(), async () => {
      stubFetch(() =>
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 7200,
          athlete: { id: 99999 },
        }),
      );
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "auth-code" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    }));

  it("POST /exchange returns 401 when Strava rejects the code", () =>
    withIdentity(identity(), async () => {
      stubFetch(
        () =>
          new Response(JSON.stringify({ error: "Bad code" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "bad-code" }),
        }),
      );
      expect(res.status).toBe(401);
    }));

  it("POST /exchange returns 409 when the Strava athlete is already linked to another user", async () => {
    const other = await createTestUser({ role: "premium" });
    await getDb().update(users).set({ stravaId: "88888" }).where(eq(users.id, other.id));
    try {
      await withIdentity(identity(), async () => {
        stubFetch(() =>
          Response.json({
            access_token: "a",
            refresh_token: "r",
            expires_at: Math.floor(Date.now() / 1000) + 7200,
            athlete: { id: 88888 },
          }),
        );
        const res = await app.fetch(
          new Request("http://test/api/v1/strava/auth/exchange", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: "auth-code" }),
          }),
        );
        expect(res.status).toBe(409);
      });
    } finally {
      await deleteTestUser(other.id);
    }
  });
});

describe("/api/strava (sync, mocked stravaApiService)", () => {
  it("GET /sync/activities returns filtered Strava activities", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/sync/activities?page=1"),
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }));

  it("POST /sync/activities returns per-id sync results", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/sync/activities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [111, 222] }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0].status).toBe("success");
    }));
});

describe("/api/strava/webhook", () => {
  it("403s for a non-admin caller", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/webhook/subscription"),
      );
      expect(res.status).toBe(403);
    }));

  it("GET /subscribe forwards to Strava", () =>
    withIdentity(adminIdentity(), async () => {
      stubFetch(
        () =>
          new Response(JSON.stringify({ id: 12345 }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/webhook/subscribe"),
      );
      expect([200, 201]).toContain(res.status);
      const body = await res.json();
      expect(body.id).toBe(12345);
    }));

  it("GET /subscription lists subscriptions", () =>
    withIdentity(adminIdentity(), async () => {
      stubFetch(() => Response.json([{ id: 1, callback_url: "http://x" }]));
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/webhook/subscription"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }));

  it("DELETE /subscription/:id reports success", () =>
    withIdentity(adminIdentity(), async () => {
      stubFetch(() => new Response(null, { status: 204 }));
      const res = await app.fetch(
        new Request("http://test/api/v1/strava/webhook/subscription/42", {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toContain("deleted");
    }));
});
