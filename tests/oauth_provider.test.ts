// The authorization-server side of the MCP cutover: dynamic client registration
// (which is what lets Claude/ChatGPT self-register instead of pasting a client
// ID) and the branded sign-in / consent pages Better Auth redirects to. The
// pages are served at the app root, outside `/api/*`, so `clientKeyGuard` never
// sees browser traffic from an OAuth flow.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { auth } from "../src/auth";
import { registerOAuthProviderPages } from "../src/web/oauth_pages";
import { closePool, getPool } from "./helpers/db";

const ORIGIN = "http://localhost:3000";

const pagesApp = new Hono();
registerOAuthProviderPages(pagesApp);

const registeredClientIds: string[] = [];

async function register(body: Record<string, unknown>): Promise<Response> {
  return auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  for (const clientId of registeredClientIds) {
    await getPool().query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
  }
  await closePool();
});

describe("dynamic client registration", () => {
  it("registers an unauthenticated client and returns credentials", async () => {
    const res = await register({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Test Connector",
      token_endpoint_auth_method: "none",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.client_id).toBe("string");
    registeredClientIds.push(body.client_id);
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);

    const { rows } = await getPool().query(`SELECT name FROM oauth_clients WHERE client_id = $1`, [
      body.client_id,
    ]);
    expect(rows[0].name).toBe("Test Connector");
  });

  it("rejects a registration without a redirect URI", async () => {
    const res = await register({ client_name: "No Redirect" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("OAuth sign-in page", () => {
  it("refuses to render outside an authorization request", async () => {
    const res = await pagesApp.request("/oauth/sign-in");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("only be opened from an authorization request");
  });

  it("renders the OTP form when handed a signed authorization query", async () => {
    const res = await pagesApp.request("/oauth/sign-in?client_id=abc&sig=deadbeef&ba_param=sig");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('id="email"');
    expect(html).toContain('id="otp"');
    expect(html).toContain("/oauth/sign-in/verify");
  });
});

describe("OAuth consent page", () => {
  it("refuses to render without a signed authorization query", async () => {
    const res = await pagesApp.request("/oauth/consent?client_id=abc");
    expect(res.status).toBe(400);
  });

  it("404-equivalents an unknown client", async () => {
    const res = await pagesApp.request(
      `/oauth/consent?client_id=${randomUUID()}&sig=deadbeef&ba_param=sig&scope=profile`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("could not be found");
  });

  it("escapes an attacker-supplied client name", async () => {
    const clientId = `xss_probe_${randomUUID()}`;
    registeredClientIds.push(clientId);
    await getPool().query(
      `INSERT INTO oauth_clients (client_id, redirect_uris, name)
       VALUES ($1, ARRAY['https://client.test/cb'], $2)`,
      [clientId, '<script>alert("xss")</script>'],
    );

    const res = await pagesApp.request(
      `/oauth/consent?client_id=${clientId}&sig=deadbeef&ba_param=sig&scope=profile%20email`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Your name and profile details");
    expect(html).toContain("Your email address");
  });
});
