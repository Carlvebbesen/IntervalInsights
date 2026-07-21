import type { Context, Env, Hono } from "hono";
import { auth } from "../auth";
import { logger } from "../logger";
import { MCP_SCOPES, OAUTH_CONSENT_PAGE, OAUTH_LOGIN_PAGE } from "../services/oauth_server_tokens";
import { shell } from "./pages";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

const SCOPE_LABELS: Record<string, string> = {
  profile: "Your name and profile details",
  email: "Your email address",
  offline_access: "Continued access while you are not signed in",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FORM_STYLES = `
  <style>
    main.doc { max-width: 460px; }
    .oauth-field { display: block; margin: 1.25rem 0 0.4rem; font-weight: 600; color: #0F0A51; }
    .oauth-input {
      width: 100%; padding: 0.75rem 0.9rem; font-size: 1rem; font-family: inherit;
      border: 1px solid #CBD5E1; border-radius: 10px; background: #fff; color: #334155;
    }
    .oauth-input:focus { outline: none; border-color: #448AFF; box-shadow: 0 0 0 3px #448AFF22; }
    .oauth-input:disabled { background: #F8FAFC; color: #94A3B8; }
    .oauth-btn {
      width: 100%; margin-top: 1.5rem; padding: 0.8rem 1rem; font-size: 1rem; font-weight: 600;
      font-family: inherit; border: none; border-radius: 10px; background: #448AFF; color: #fff;
      cursor: pointer;
    }
    .oauth-btn:hover { background: #2F73E8; }
    .oauth-btn:disabled { background: #CBD5E1; cursor: not-allowed; }
    .oauth-btn.secondary { background: #fff; color: #64748B; border: 1px solid #CBD5E1; }
    .oauth-btn.secondary:hover { background: #F8FAFC; color: #334155; }
    .oauth-actions { display: flex; gap: 0.75rem; }
    .oauth-error {
      margin-top: 1rem; padding: 0.75rem 1rem; border-radius: 10px;
      background: #FEF2F2; border: 1px solid #FECACA; color: #B91C1C; font-size: 0.92rem;
    }
    .oauth-error:empty { display: none; }
    .oauth-scopes { list-style: none; margin: 1.25rem 0 0; }
    .oauth-scopes li {
      padding: 0.6rem 0.9rem; margin: 0.4rem 0; border-radius: 10px;
      background: #F8FAFC; border: 1px solid #E2E8F0;
    }
    .oauth-client {
      display: block; font-size: 1.05rem; font-weight: 700; color: #0F0A51;
      word-break: break-word;
    }
    .hidden { display: none; }
  </style>
`;

// The provider signs the authorize query it hands to these pages; anything the
// page adds must be stripped before it is echoed back or the signature fails.
const SIGNED_QUERY_JS = `
  function signedQuery() {
    var params = new URLSearchParams(location.search);
    if (!params.has("sig")) return "";
    var names = params.getAll("ba_param");
    if (!names.length) return "";
    var allowed = new Set(names);
    var out = new URLSearchParams();
    params.forEach(function (value, key) {
      if (key === "sig" || key === "ba_param" || allowed.has(key)) out.append(key, value);
    });
    return out.toString();
  }
  async function post(path, body) {
    var res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || data.error || "Something went wrong.");
    return data;
  }
`;

function invalidRequestPage(message: string): Response {
  const html = shell(
    "Authorization",
    `${FORM_STYLES}
    <h1>Authorization request invalid</h1>
    <p class="lead">${escapeHtml(message)}</p>
    <p>Close this window and start the connection again from your client.</p>`,
  );
  return new Response(html, { status: 400, headers: HTML_HEADERS });
}

function signInPage(): Response {
  const html = shell(
    "Sign in",
    `${FORM_STYLES}
    <h1>Sign in to continue</h1>
    <p class="lead">Enter the email address for your Interval Insights account. We'll send you a
    six-digit code.</p>

    <label class="oauth-field" for="email">Email address</label>
    <input class="oauth-input" id="email" type="email" autocomplete="email" autofocus />

    <div id="otp-step" class="hidden">
      <label class="oauth-field" for="otp">Six-digit code</label>
      <input class="oauth-input" id="otp" inputmode="numeric" autocomplete="one-time-code"
        maxlength="6" />
    </div>

    <button class="oauth-btn" id="submit">Send code</button>
    <div class="oauth-error" id="error"></div>

    <script>
      ${SIGNED_QUERY_JS}
      var emailEl = document.getElementById("email");
      var otpEl = document.getElementById("otp");
      var otpStep = document.getElementById("otp-step");
      var btn = document.getElementById("submit");
      var errEl = document.getElementById("error");
      var stage = "email";

      async function submit() {
        errEl.textContent = "";
        btn.disabled = true;
        try {
          if (stage === "email") {
            if (!emailEl.value.trim()) throw new Error("Enter your email address.");
            await post("/oauth/sign-in/send", { email: emailEl.value.trim() });
            stage = "otp";
            emailEl.disabled = true;
            otpStep.classList.remove("hidden");
            btn.textContent = "Sign in";
            otpEl.focus();
          } else {
            var data = await post("/oauth/sign-in/verify", {
              email: emailEl.value.trim(),
              otp: otpEl.value.trim(),
              oauth_query: signedQuery(),
            });
            if (!data.url) throw new Error("Sign-in succeeded but the authorization could not resume.");
            location.href = data.url;
            return;
          }
        } catch (e) {
          errEl.textContent = e.message;
        }
        btn.disabled = false;
      }

      btn.addEventListener("click", submit);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !btn.disabled) submit();
      });
    </script>`,
  );
  return new Response(html, { headers: HTML_HEADERS });
}

function consentPage(clientName: string, clientUri: string | null, scopes: string[]): Response {
  const scopeItems = scopes
    .map((s) => `<li>${escapeHtml(SCOPE_LABELS[s] ?? s)}</li>`)
    .join("\n      ");
  const clientLine = clientUri
    ? `<a class="oauth-client" href="${escapeHtml(clientUri)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(clientName)}</a>`
    : `<span class="oauth-client">${escapeHtml(clientName)}</span>`;

  const html = shell(
    "Authorize",
    `${FORM_STYLES}
    <h1>Authorize access</h1>
    <p class="lead">${clientLine} wants to connect to your Interval Insights account.</p>

    <p>It will be able to read and edit your training data on your behalf:</p>
    <ul class="oauth-scopes">
      ${scopeItems}
    </ul>

    <div class="oauth-actions">
      <button class="oauth-btn secondary" id="deny">Deny</button>
      <button class="oauth-btn" id="approve">Allow</button>
    </div>
    <div class="oauth-error" id="error"></div>

    <script>
      ${SIGNED_QUERY_JS}
      var errEl = document.getElementById("error");
      var approve = document.getElementById("approve");
      var deny = document.getElementById("deny");

      async function decide(accept) {
        errEl.textContent = "";
        approve.disabled = true;
        deny.disabled = true;
        try {
          var data = await post("/oauth/consent", { accept: accept, oauth_query: signedQuery() });
          if (!data.url) throw new Error("The authorization could not be completed.");
          location.href = data.url;
          return;
        } catch (e) {
          errEl.textContent = e.message;
        }
        approve.disabled = false;
        deny.disabled = false;
      }

      approve.addEventListener("click", function () { decide(true); });
      deny.addEventListener("click", function () { decide(false); });
    </script>`,
  );
  return new Response(html, { headers: HTML_HEADERS });
}

async function forwardToAuth(c: Context, path: string, body: unknown): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  headers.delete("content-length");
  return auth.handler(
    new Request(new URL(path, c.req.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

export function registerOAuthProviderPages<E extends Env>(app: Hono<E>): void {
  app.get(OAUTH_LOGIN_PAGE, (c) => {
    if (!c.req.query("sig")) {
      return invalidRequestPage("This page can only be opened from an authorization request.");
    }
    return signInPage();
  });

  app.post("/oauth/sign-in/send", async (c) => {
    const { email } = await c.req.json<{ email?: string }>();
    if (!email) return c.json({ error: "Email is required" }, 400);
    return forwardToAuth(c, "/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
  });

  app.post("/oauth/sign-in/verify", async (c) => {
    const body = await c.req.json<{ email?: string; otp?: string; oauth_query?: string }>();
    if (!body.email || !body.otp) return c.json({ error: "Email and code are required" }, 400);
    return forwardToAuth(c, "/api/auth/sign-in/email-otp", {
      email: body.email,
      otp: body.otp,
      oauth_query: body.oauth_query,
    });
  });

  app.get(OAUTH_CONSENT_PAGE, async (c) => {
    const clientId = c.req.query("client_id");
    if (!c.req.query("sig") || !clientId) {
      return invalidRequestPage("This page can only be opened from an authorization request.");
    }

    const requested = (c.req.query("scope") ?? "").split(" ").filter(Boolean);
    const scopes = requested.length ? requested : [...MCP_SCOPES];

    let client: Awaited<ReturnType<typeof auth.api.getOAuthClientPublic>> | null = null;
    try {
      client = await auth.api.getOAuthClientPublic({
        query: { client_id: clientId },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      logger.warn({ err, clientId }, "oauth: could not load client for consent page");
    }
    if (!client) return invalidRequestPage("The application requesting access could not be found.");

    return consentPage(client.client_name || "An application", client.client_uri ?? null, scopes);
  });

  app.post(OAUTH_CONSENT_PAGE, async (c) => {
    const body = await c.req.json<{ accept?: boolean; oauth_query?: string }>();
    return forwardToAuth(c, "/api/auth/oauth2/consent", {
      accept: body.accept === true,
      oauth_query: body.oauth_query,
    });
  });
}
