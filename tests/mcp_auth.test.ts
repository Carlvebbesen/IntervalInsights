// The MCP endpoint's auth wall. `mcpAuth` verifies Clerk OAuth access tokens
// (NOT `/api/*` session tokens) and auto-provisions a users row on first
// contact. The auth path is driven through a minimal probe app so the test
// pool's db is used; the discovery + 405 routes go through the real mcpRouter
// (whose middleware injects src/db.ts's db — same test database, own pool).

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { pool as appDbPool } from "../src/db";
import { mcpAuth } from "../src/mcp/auth";
import type { TMcpEnv } from "../src/mcp/types";
import mcpRouter from "../src/routers/mcp_router";
import { clerkUsersMock } from "./setup";
import { closePool, getDb, getPool } from "./helpers/db";

const db = getDb();

// Probe app: mcpAuth + a route that reports the resolved identity.
const probeApp = new Hono<TMcpEnv>();
probeApp.use("/mcp", mcpAuth);
probeApp.post("/mcp", (c) =>
  c.json({ userId: c.get("userId"), clerkUserId: c.get("clerkUserId") }),
);
const probeFetch = (req: Request) => probeApp.fetch(req, { db });

const routerFetch = (req: Request) => mcpRouter.fetch(req, { db });

/** What Clerk's requestState.toAuth() returns for a valid oauth_token — the
 *  exact shape @clerk/mcp-tools' verifyClerkToken requires. */
function grantOauthTokenFor(clerkUserId: string) {
  clerkUsersMock.authenticateRequest = async () => ({
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: "oauth_token",
      clientId: "client_test",
      scopes: ["profile", "email"],
      userId: clerkUserId,
    }),
  });
}

const provisionedClerkIds: string[] = [];

afterEach(() => {
  clerkUsersMock.reset();
});

afterAll(async () => {
  for (const clerkId of provisionedClerkIds) {
    await getPool().query(`DELETE FROM users WHERE clerk_id = $1`, [clerkId]);
  }
  await appDbPool.end();
  await closePool();
});

describe("mcpAuth", () => {
  it("401s a request without a token, pointing at the resource metadata", async () => {
    const res = await probeFetch(new Request("http://test/mcp", { method: "POST" }));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain("resource_metadata=");
  });

  it("401s an invalid token (Clerk says unauthenticated)", async () => {
    const res = await probeFetch(
      new Request("http://test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-token" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate") ?? "").toContain('error="invalid_token"');
  });

  it("passes a valid token through and auto-provisions a users row (idempotently)", async () => {
    const clerkId = `test_clerk_mcp_${crypto.randomUUID()}`;
    provisionedClerkIds.push(clerkId);
    grantOauthTokenFor(clerkId);

    const request = () =>
      probeFetch(
        new Request("http://test/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer opaque-test-oauth-token" },
        }),
      );

    const res = await request();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clerkUserId).toBe(clerkId);

    const rows = await getPool().query(`SELECT id FROM users WHERE clerk_id = $1`, [clerkId]);
    expect(rows.rowCount).toBe(1);
    expect(body.userId).toBe(rows.rows[0].id);

    // Second request reuses the row instead of inserting a duplicate.
    const again = await request();
    expect(again.status).toBe(200);
    const rowsAfter = await getPool().query(`SELECT id FROM users WHERE clerk_id = $1`, [
      clerkId,
    ]);
    expect(rowsAfter.rowCount).toBe(1);
  });
});

describe("mcpRouter", () => {
  it("rejects GET /mcp with 405 even when authenticated (stateless server)", async () => {
    const clerkId = `test_clerk_mcp_${crypto.randomUUID()}`;
    provisionedClerkIds.push(clerkId);
    grantOauthTokenFor(clerkId);

    const res = await routerFetch(
      new Request("http://test/mcp", {
        method: "GET",
        headers: { Authorization: "Bearer opaque-test-oauth-token" },
      }),
    );
    expect(res.status).toBe(405);
  });

  it("serves the protected-resource metadata unauthenticated", async () => {
    const res = await routerFetch(
      new Request("http://test/.well-known/oauth-protected-resource/mcp"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toMatch(/^https?:\/\/localhost:3000\/mcp$/);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
  });

  it("returns 503 when the authorization-server metadata fetch fails upstream", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      const res = await routerFetch(
        new Request("http://test/.well-known/oauth-authorization-server"),
      );
      expect(res.status).toBe(503);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
