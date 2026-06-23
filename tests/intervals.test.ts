import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
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

function stubFetch(handler: (input: Request | URL | string) => Response) {
  globalThis.fetch = (async (input: Request | URL | string) =>
    handler(input)) as typeof globalThis.fetch;
}

describe("/api/intervals/auth", () => {
  it("GET /url returns the intervals.icu authorize URL", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/intervals/auth/url"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toContain("intervals.icu/oauth/authorize");
    }));

  it("POST /exchange succeeds when intervals.icu accepts the code", () =>
    withIdentity(identity(), async () => {
      stubFetch(() =>
        Response.json({
          access_token: "intervals-access",
          refresh_token: "intervals-refresh",
          expires_in: 3600,
          athlete_id: "i999",
        }),
      );
      const res = await app.fetch(
        new Request("http://test/api/intervals/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "auth-code" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    }));

  it("POST /exchange surfaces 401 when intervals.icu rejects", () =>
    withIdentity(identity(), async () => {
      stubFetch(
        () =>
          new Response(JSON.stringify({ message: "bad code" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      );
      const res = await app.fetch(
        new Request("http://test/api/intervals/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "bad" }),
        }),
      );
      expect(res.status).toBe(401);
    }));

  it("POST /disconnect succeeds", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/intervals/auth/disconnect", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    }));

  it("GET /status reports connection state", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/intervals/auth/status"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.connected).toBe("boolean");
    }));
});

describe("/api/intervals (sync)", () => {
  it("POST /sync kicks off the link service in the background", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/intervals/sync", { method: "POST" }),
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe("started");
    }));
});
