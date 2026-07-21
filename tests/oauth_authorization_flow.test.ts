// End-to-end walk of the whole cutover in-process: dynamic client registration
// → /oauth2/authorize → our own sign-in page → consent → token exchange → an
// authenticated MCP call. This is the substitute for driving a real connector
// through a browser, and it is the only test that covers the two contracts the
// provider imposes on pages we host ourselves:
//
//   1. the signed authorization query must be echoed back verbatim-but-filtered
//      (only `sig`, `ba_param`, and the params `ba_param` names), and
//   2. the sign-in response body is replaced by the provider's after-hook with
//      `{ redirect, url }` once the session cookie is set.

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { auth } from "../src/auth";
import { mcpAuth } from "../src/mcp/auth";
import type { TMcpEnv } from "../src/mcp/types";
import { MCP_RESOURCE_URL } from "../src/services/oauth_server_tokens";
import { registerOAuthProviderPages } from "../src/web/oauth_pages";
import { closePool, getDb, getPool } from "./helpers/db";
import { otpCapture } from "./setup";

const ORIGIN = "http://localhost:3000";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const pagesApp = new Hono();
registerOAuthProviderPages(pagesApp);

const mcpApp = new Hono<TMcpEnv>();
mcpApp.use("/mcp", mcpAuth);
mcpApp.post("/mcp", (c) => c.json({ userId: c.get("userId"), scopes: c.get("scopes") }));

const email = `oauth-flow-${randomUUID()}@test.local`;
let userId: string;
let clientId: string;

const base64url = (buf: Buffer) => buf.toString("base64url");
const verifier = base64url(Buffer.from(randomUUID() + randomUUID()));
const challenge = base64url(createHash("sha256").update(verifier).digest());

/** Mirrors the provider's own `buildSignedOAuthQuery`. */
function signedQuery(search: string): string {
  const params = new URLSearchParams(search);
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === "sig" || key === "ba_param" || names.has(key)) out.append(key, value);
  }
  return out.toString();
}

const jsonHeaders = (cookie?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: ORIGIN,
  ...(cookie ? { Cookie: cookie } : {}),
});

beforeAll(async () => {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (email, email_verified, name, role)
     VALUES ($1, true, 'OAuth Flow', 'premium') RETURNING id`,
    [email],
  );
  userId = rows[0].id;
});

afterAll(async () => {
  const pool = getPool();
  if (clientId) {
    await pool.query(`DELETE FROM oauth_access_tokens WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_refresh_tokens WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consents WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
  }
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closePool();
});

describe("full authorization-code flow", () => {
  it("registers, signs in, consents, exchanges a code, and calls MCP", async () => {
    // 1 — the connector registers itself (no client ID pasted anywhere).
    const registration = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          client_name: "Flow Test Connector",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      }),
    );
    expect(registration.ok).toBe(true);
    clientId = (await registration.json()).client_id;

    // 2 — authorize with no session bounces to our own sign-in page.
    const authorizeUrl = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "profile email offline_access",
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const authorize = await auth.handler(
      new Request(authorizeUrl, { headers: { Accept: "application/json", Origin: ORIGIN } }),
    );
    expect(authorize.ok).toBe(true);
    const loginUrl = new URL((await authorize.json()).url, ORIGIN);
    expect(loginUrl.pathname).toBe("/oauth/sign-in");

    // The sign-in page renders from that signed query.
    expect((await pagesApp.request(`/oauth/sign-in${loginUrl.search}`)).status).toBe(200);

    // 3 — email OTP over cookies, through the app-root proxy (never /api/*).
    const query = signedQuery(loginUrl.search);
    const send = await pagesApp.request("/oauth/sign-in/send", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email }),
    });
    expect(send.ok).toBe(true);
    expect(otpCapture.last?.email).toBe(email);
    const otp = otpCapture.last?.otp as string;

    // 4 — verifying sets the session cookie, and the provider's after-hook
    // replaces the sign-in payload with the resumed authorize redirect.
    const verify = await pagesApp.request("/oauth/sign-in/verify", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, otp, oauth_query: query }),
    });
    expect(verify.ok).toBe(true);
    const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("session_token");
    const afterLogin = new URL((await verify.json()).url, ORIGIN);
    expect(afterLogin.pathname).toBe("/oauth/consent");

    // 5 — the consent page names the client, then approval yields the code.
    const consentHtml = await (
      await pagesApp.request(`/oauth/consent${afterLogin.search}`, { headers: { Cookie: cookie } })
    ).text();
    expect(consentHtml).toContain("Flow Test Connector");

    const consent = await pagesApp.request("/oauth/consent", {
      method: "POST",
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ accept: true, oauth_query: signedQuery(afterLogin.search) }),
    });
    expect(consent.ok).toBe(true);
    const callback = new URL((await consent.json()).url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("state-123");
    const code = callback.searchParams.get("code") as string;
    expect(code).toBeTruthy();

    // 6 — the token exchange. `resource` is what makes the provider mint a JWT
    // audienced at /mcp instead of an opaque token.
    const token = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          resource: MCP_RESOURCE_URL,
        }).toString(),
      }),
    );
    expect(token.ok).toBe(true);
    const grant = await token.json();
    expect(grant.token_type).toBe("Bearer");
    expect(grant.refresh_token).toBeTruthy();

    // 7 — and that token authenticates a real MCP call as the right user.
    const mcp = await mcpApp.fetch(
      new Request("http://test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${grant.access_token}` },
      }),
      { db: getDb() },
    );
    expect(mcp.status).toBe(200);
    expect((await mcp.json()).userId).toBe(userId);
  });

  it("rejects a consent POST whose signed query has been tampered with", async () => {
    const res = await pagesApp.request("/oauth/consent", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        accept: true,
        oauth_query: `client_id=${clientId}&scope=profile&sig=forged&ba_param=client_id&ba_param=scope&ba_param=sig`,
      }),
    });
    expect(res.ok).toBe(false);
  });
});
