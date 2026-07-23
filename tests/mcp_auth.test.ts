// The MCP endpoint's auth wall. `mcpAuth` verifies OAuth access tokens minted by
// our own Better Auth authorization server — JWTs (when the client sent an RFC
// 8707 `resource`) verified against the local JWKS, and opaque tokens looked up
// in `oauth_access_tokens`. It never creates a user: the account must already
// exist, because the token could only be issued after a sign-in.
//
// The auth path is driven through a minimal probe app so the test pool's db is
// used; the discovery + 405 routes go through the real mcpRouter (whose
// middleware injects src/db.ts's db — same test database, own pool).

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { auth } from "../src/auth";
import { mcpAuth } from "../src/mcp/auth";
import type { TMcpEnv } from "../src/mcp/types";
import mcpRouter from "../src/routers/mcp_router";
import {
  AUTH_ISSUER,
  hashOAuthToken,
  MCP_RESOURCE_URL,
} from "../src/services/oauth_server_tokens";
import { closePool, getDb, getPool } from "./helpers/db";

const db = getDb();

const probeApp = new Hono<TMcpEnv>();
probeApp.use("/mcp", mcpAuth);
probeApp.post("/mcp", (c) => c.json({ userId: c.get("userId"), scopes: c.get("scopes") }));
const probeFetch = (req: Request) => probeApp.fetch(req, { db });

const routerFetch = (req: Request) => mcpRouter.fetch(req, { db });

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

async function seedUser(): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (email, email_verified, name, role)
     VALUES ($1, true, 'MCP Test', 'premium') RETURNING id`,
    [`mcp-test-${randomUUID()}@test.local`],
  );
  createdUserIds.push(rows[0].id);
  return rows[0].id;
}

async function seedClient(opts?: { disabled?: boolean }): Promise<string> {
  const clientId = `mcp_test_client_${randomUUID()}`;
  await getPool().query(
    `INSERT INTO oauth_clients (client_id, redirect_uris, disabled, name)
     VALUES ($1, ARRAY['https://client.test/callback'], $2, 'MCP Test Client')`,
    [clientId, opts?.disabled ?? false],
  );
  createdClientIds.push(clientId);
  return clientId;
}

async function seedOpaqueToken(opts: {
  userId: string;
  clientId: string;
  expiresAt?: Date;
  scopes?: string[];
}): Promise<string> {
  const token = `opaque_${randomUUID()}`;
  await getPool().query(
    `INSERT INTO oauth_access_tokens (token, client_id, user_id, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      hashOAuthToken(token),
      opts.clientId,
      opts.userId,
      opts.expiresAt ?? new Date(Date.now() + 3_600_000),
      opts.scopes ?? ["profile", "email"],
    ],
  );
  return token;
}

async function seedConsent(userId: string, clientId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_consents (client_id, user_id, scopes) VALUES ($1, $2, $3)`,
    [clientId, userId, ["profile", "email"]],
  );
}

// A JWT is only honoured while the user still has a live consent for its client
// (see jwtGrantValid). Every JWT happy path therefore needs both a client and a
// consent seeded.
async function grantJwtClient(userId: string, opts?: { disabled?: boolean }): Promise<string> {
  const clientId = await seedClient(opts);
  await seedConsent(userId, clientId);
  return clientId;
}

async function signAccessToken(payload: Record<string, unknown>): Promise<string> {
  const { token } = await auth.api.signJWT({
    body: { payload: { iss: AUTH_ISSUER, aud: MCP_RESOURCE_URL, ...payload } },
  });
  return token;
}

const post = (token?: string) =>
  probeFetch(
    new Request("http://test/mcp", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

afterAll(async () => {
  const pool = getPool();
  for (const clientId of createdClientIds) {
    await pool.query(`DELETE FROM oauth_access_tokens WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consents WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
  }
  for (const userId of createdUserIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
  // Do NOT end src/db.ts's pool here: it lives for the whole test process.
  await closePool();
});

describe("mcpAuth", () => {
  it("401s a request without a token, pointing at the resource metadata", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("401s a token that is neither a valid JWT nor a known opaque token", async () => {
    const res = await post("not-a-real-token");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate") ?? "").toContain('error="invalid_token"');
  });

  it("accepts a JWT access token and resolves the user and scopes", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId);
    const token = await signAccessToken({
      sub: userId,
      azp: clientId,
      scope: "profile email offline_access",
    });

    const res = await post(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(userId);
    expect(body.scopes).toEqual(["profile", "email", "offline_access"]);
  });

  it("401s a JWT issued for a different audience", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId);
    const token = await signAccessToken({
      sub: userId,
      azp: clientId,
      aud: "https://elsewhere.test/mcp",
    });

    expect((await post(token)).status).toBe(401);
  });

  it("401s a JWT whose subject is not a known user", async () => {
    const clientId = await seedClient();
    const token = await signAccessToken({ sub: randomUUID(), azp: clientId, scope: "profile" });

    expect((await post(token)).status).toBe(401);
  });

  it("accepts an opaque access token and resolves the user and scopes", async () => {
    const userId = await seedUser();
    const clientId = await seedClient();
    const token = await seedOpaqueToken({ userId, clientId, scopes: ["profile", "email"] });

    const res = await post(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(userId);
    expect(body.scopes).toEqual(["profile", "email"]);
  });

  it("401s an expired opaque access token", async () => {
    const userId = await seedUser();
    const clientId = await seedClient();
    const token = await seedOpaqueToken({
      userId,
      clientId,
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await post(token)).status).toBe(401);
  });

  it("401s an opaque access token whose client has been disabled", async () => {
    const userId = await seedUser();
    const clientId = await seedClient({ disabled: true });
    const token = await seedOpaqueToken({ userId, clientId });

    expect((await post(token)).status).toBe(401);
  });

  it("401s a JWT access token whose client has been disabled", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId, { disabled: true });
    const token = await signAccessToken({ sub: userId, azp: clientId, scope: "profile" });

    expect((await post(token)).status).toBe(401);
  });

  it("401s a JWT once the user revokes the client's consent", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId);
    const token = await signAccessToken({ sub: userId, azp: clientId, scope: "profile" });
    expect((await post(token)).status).toBe(200);

    await getPool().query(`DELETE FROM oauth_consents WHERE user_id = $1 AND client_id = $2`, [
      userId,
      clientId,
    ]);

    expect((await post(token)).status).toBe(401);
  });

  it("401s a JWT access token from a client that no longer exists", async () => {
    const userId = await seedUser();
    const token = await signAccessToken({ sub: userId, azp: "gone", scope: "profile" });

    expect((await post(token)).status).toBe(401);
  });

  it("401s a JWT minted by a different issuer", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId);
    const token = await signAccessToken({
      sub: userId,
      azp: clientId,
      iss: "https://evil.test/api/auth",
    });

    expect((await post(token)).status).toBe(401);
  });

  // Banning revokes sessions, but oauth_access_tokens.session_id is ON DELETE
  // SET NULL — so the grant outlives the ban and this check is the only gate.
  it("403s a banned user still holding a valid grant", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId);
    const opaque = await seedOpaqueToken({ userId, clientId });
    const jwt = await signAccessToken({ sub: userId, azp: clientId, scope: "profile" });
    expect((await post(opaque)).status).toBe(200);

    await getPool().query(`UPDATE users SET banned = true WHERE id = $1`, [userId]);
    await getPool().query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

    expect((await post(opaque)).status).toBe(403);
    expect((await post(jwt)).status).toBe(403);
  });
});

describe("mcpRouter discovery", () => {
  it("rejects GET /mcp with 405 even when authenticated (stateless server)", async () => {
    const userId = await seedUser();
    const clientId = await grantJwtClient(userId);
    const token = await signAccessToken({ sub: userId, azp: clientId, scope: "profile" });

    const res = await routerFetch(
      new Request("http://test/mcp", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(405);
  });

  it("serves the protected-resource metadata unauthenticated", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await routerFetch(new Request(`http://test${path}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resource).toBe(MCP_RESOURCE_URL);
      expect(body.authorization_servers).toEqual([AUTH_ISSUER]);
      expect(body.scopes_supported).not.toContain("openid");
    }
  });

  it("serves Better Auth's authorization-server metadata at the root aliases", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      const res = await routerFetch(new Request(`http://test${path}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issuer).toBe(AUTH_ISSUER);
      expect(body.authorization_endpoint).toContain("/oauth2/authorize");
      expect(body.token_endpoint).toContain("/oauth2/token");
      expect(body.registration_endpoint).toContain("/oauth2/register");
      expect(body.jwks_uri).toContain("/jwks");
    }
  });
});
