import type { Env, Hono } from "hono";
import { config } from "../config";

const ANDROID_PACKAGE = "no.cvebbesen.intervalinsights";
const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
// Only these OAuth params are forwarded to the app; anything else in the query is dropped.
const FORWARDED_PARAMS = ["code", "error", "state", "scope"] as const;

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #F1F5F9;
    color: #334155;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    display: flex;
    min-height: 100vh;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }
  main {
    max-width: 420px;
    width: 100%;
    background: #fff;
    border: 1px solid #CBD5E1;
    border-radius: 16px;
    padding: 2.5rem 2rem;
    box-shadow: 0 4px 24px rgba(15, 10, 81, 0.05);
    text-align: center;
  }
  img.icon { width: 64px; height: 64px; object-fit: contain; margin-bottom: 1rem; }
  h1 {
    font-size: 1.4rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0F0A51;
    margin-bottom: 0.75rem;
  }
  p { margin: 0.5rem 0 1.5rem; color: #475569; }
  a.button {
    display: inline-block;
    background: #448AFF;
    color: #fff;
    font-weight: 700;
    text-decoration: none;
    padding: 0.85rem 2rem;
    border-radius: 999px;
  }
  a.button:hover { background: #2F6FE0; }
  p.hint { margin: 1.25rem 0 0; font-size: 0.85rem; color: #94A3B8; }
  p.hint a { color: #64748B; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trampolinePage(
  provider: string,
  appLinkUrl: string,
  intentUrl: string,
  denied: boolean,
): string {
  const title = denied ? `${provider} connection cancelled` : `${provider} connected`;
  const lead = denied
    ? `The ${provider} authorization was not completed. Return to the app to try again.`
    : `Almost done — return to the app to finish connecting ${provider}.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} · Interval Insights</title>
  <link rel="icon" type="image/png" href="/favicon.ico" />
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <img class="icon" src="/app-icon.png" alt="Interval Insights icon" />
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(lead)}</p>
    <a id="open-app" class="button" href="${escapeHtml(appLinkUrl)}">Open Interval Insights</a>
    <p class="hint">
      Nothing happening? Get the app on
      <a href="${escapeHtml(PLAY_STORE_URL)}">Google Play</a>.
    </p>
  </main>
  <script>
    (function () {
      if (/android/i.test(navigator.userAgent)) {
        document.getElementById("open-app").setAttribute("href", ${JSON.stringify(intentUrl)});
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * OAuth callback "trampoline" pages at the universal-link paths. The OS is
 * supposed to intercept these URLs before any request is made, but browsers
 * keep non-gesture redirects in the tab (intervals.icu always; Strava when its
 * app isn't installed). This page hands the flow back to the app via a
 * gesture-driven tap — an Android intent:// link (with a Play Store fallback)
 * or the plain universal link elsewhere. Mounted in src/index.ts and the test app.
 */
export function registerOAuthCallbackPages<E extends Env>(app: Hono<E>): void {
  const callbacks = [
    { path: "/strava-callback", provider: "Strava" },
    { path: "/intervals-callback", provider: "intervals.icu" },
  ] as const;

  for (const { path, provider } of callbacks) {
    app.get(path, (c) => {
      const params = new URLSearchParams();
      for (const key of FORWARDED_PARAMS) {
        const value = c.req.query(key);
        if (value !== undefined) params.set(key, value);
      }
      const appLink = new URL(path, config.APP_BASE_URL);
      appLink.search = params.toString();
      const intentUrl = `intent://${appLink.host}${path}${appLink.search}#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
      const html = trampolinePage(provider, appLink.toString(), intentUrl, params.has("error"));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    });
  }
}
