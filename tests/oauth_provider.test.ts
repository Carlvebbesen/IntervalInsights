// The authorization-server side of the MCP cutover: dynamic client registration
// (which is what lets Claude/ChatGPT self-register instead of pasting a client
// ID) and the branded sign-in / consent pages Better Auth redirects to. The
// pages are served at the app root, outside `/api/*`, so `clientKeyGuard` never
// sees browser traffic from an OAuth flow.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { auth } from "../src/auth";
import { consentPage, registerOAuthProviderPages } from "../src/web/oauth_pages";
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

    expect(res.ok).toBe(true);
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

describe("OAuth sign-in proxy routes", () => {
  // These live at the app root, outside clientKeyGuard — without the signature
  // check they would be an open OTP oracle.
  it("401s a send with no signed authorization query", async () => {
    const res = await pagesApp.request("/oauth/sign-in/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "victim@test.local" }),
    });
    expect(res.status).toBe(401);
  });

  it("401s a send whose signature does not verify", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const res = await pagesApp.request("/oauth/sign-in/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "victim@test.local",
        oauth_query: `client_id=abc&exp=${exp}&sig=forged&ba_param=client_id&ba_param=exp&ba_param=sig`,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("401s a verify with no signed authorization query", async () => {
    const res = await pagesApp.request("/oauth/sign-in/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "victim@test.local", otp: "123456" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("OAuth consent page", () => {
  it("refuses to render without a signed authorization query", async () => {
    const res = await pagesApp.request("/oauth/consent?client_id=abc");
    expect(res.status).toBe(400);
  });

  it("sends a lapsed session back through sign-in, keeping the signed query", async () => {
    const query = `client_id=${randomUUID()}&sig=deadbeef&ba_param=sig&scope=profile`;
    const res = await pagesApp.request(`/oauth/consent?${query}`);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("/oauth/sign-in?")).toBe(true);
    expect(new URLSearchParams(location.split("?")[1]).get("sig")).toBe("deadbeef");
  });

  it("escapes an attacker-supplied client name and labels the requested scopes", async () => {
    const res = consentPage('<script>alert("xss")</script>', null, ["profile", "email"]);
    const html = await res.text();

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Your name and profile details");
    expect(html).toContain("Your email address");
  });

  it("renders an unknown scope verbatim rather than dropping it", async () => {
    const html = await consentPage("Some Client", null, ["write:everything"]).text();
    expect(html).toContain("write:everything");
  });

  // client_uri comes from unauthenticated DCR, so the scheme is attacker-chosen.
  it("refuses to hyperlink a non-http client URI", async () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,<script>x</script>", "not a url"]) {
      const html = await consentPage("Some Client", uri, ["profile"]).text();
      expect(html).toContain('<span class="oauth-client">Some Client</span>');
      expect(html).not.toContain("<a class=\"oauth-client\"");
    }
  });

  it("hyperlinks a plain https client URI", async () => {
    const html = await consentPage("Some Client", "https://claude.ai", ["profile"]).text();
    expect(html).toContain('href="https://claude.ai"');
  });

  it("denies framing", async () => {
    const res = consentPage("Some Client", null, ["profile"]);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
