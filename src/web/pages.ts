import type { Env, Hono } from "hono";
import { marked } from "marked";

const SUPPORT_EMAIL = "ecvebbesen@gmail.com";

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #F1F5F9;
    color: #334155;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
  }
  nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem 2rem;
    max-width: 860px;
    margin: 0 auto;
    flex-wrap: wrap;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #0F0A51;
    text-decoration: none;
  }
  .logo span { color: #448AFF; }
  .logo img { width: 34px; height: 34px; object-fit: contain; }
  .nav-back { font-size: 0.9rem; color: #64748B; text-decoration: none; }
  .nav-back:hover { color: #448AFF; }
  main.doc {
    max-width: 780px;
    margin: 1rem auto 3rem;
    background: #fff;
    border: 1px solid #CBD5E1;
    border-radius: 16px;
    padding: 3rem clamp(1.25rem, 4vw, 3rem);
    box-shadow: 0 4px 24px rgba(15, 10, 81, 0.05);
  }
  main.doc h1 {
    font-size: clamp(1.75rem, 4vw, 2.4rem);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0F0A51;
    line-height: 1.15;
    margin-bottom: 1.5rem;
  }
  main.doc h2 {
    font-size: 1.3rem;
    font-weight: 700;
    color: #0F0A51;
    margin: 2.25rem 0 0.75rem;
  }
  main.doc h3 {
    font-size: 1.05rem;
    font-weight: 700;
    color: #0F0A51;
    margin: 1.5rem 0 0.5rem;
  }
  main.doc p, main.doc li { color: #334155; }
  main.doc p { margin: 0.75rem 0; }
  main.doc ul, main.doc ol { margin: 0.75rem 0 0.75rem 1.5rem; }
  main.doc li { margin: 0.35rem 0; }
  main.doc a { color: #448AFF; text-decoration: none; }
  main.doc a:hover { text-decoration: underline; }
  main.doc strong { color: #0F0A51; }
  main.doc hr { border: none; border-top: 1px solid #E2E8F0; margin: 2rem 0; }
  main.doc blockquote {
    border-left: 3px solid #98D2EB;
    background: #F8FAFC;
    padding: 0.5rem 1rem;
    margin: 1rem 0;
    color: #475569;
  }
  main.doc code {
    background: #F1F5F9;
    border: 1px solid #E2E8F0;
    border-radius: 5px;
    padding: 0.1rem 0.35rem;
    font-size: 0.9em;
  }
  .table-wrap { overflow-x: auto; margin: 1rem 0; }
  main.doc table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92rem;
    min-width: 460px;
  }
  main.doc th, main.doc td {
    border: 1px solid #E2E8F0;
    padding: 0.6rem 0.8rem;
    text-align: left;
    vertical-align: top;
  }
  main.doc th { background: #F8FAFC; color: #0F0A51; font-weight: 600; }
  .lead {
    font-size: 1.1rem;
    color: #475569;
    margin-bottom: 1.5rem;
  }
  .callout {
    background: #98D2EB22;
    border: 1px solid #98D2EB;
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    margin: 1.5rem 0;
  }
  .callout h3 { margin-top: 0; }
  .steps { margin: 0.5rem 0 0 1.25rem; }
  .steps li { margin: 0.5rem 0; }
  .meta { color: #64748B; font-size: 0.9rem; }
  footer {
    max-width: 780px;
    margin: 0 auto;
    text-align: center;
    padding: 2rem;
    color: #94A3B8;
    font-size: 0.85rem;
    border-top: 1px solid #CBD5E1;
  }
  footer .links {
    display: flex;
    gap: 1.25rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
  footer a { color: #64748B; text-decoration: none; }
  footer a:hover { color: #448AFF; }
`;

function shell(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} · Interval Insights</title>
  <link rel="icon" type="image/png" href="/favicon.ico" />
  <style>${STYLES}</style>
</head>
<body>
  <nav>
    <a href="/" class="logo">
      <img src="/app-icon.png?v=2" alt="Interval Insights icon" />
      Interval<span>Insights</span>
    </a>
    <a href="/" class="nav-back">← Back to home</a>
  </nav>
  <main class="doc">
${content}
  </main>
  <footer>
    <div class="links">
      <a href="/">Home</a>
      <a href="/privacy-policy">Privacy Policy</a>
      <a href="/terms-of-service">Terms of Service</a>
      <a href="/display/delete-account">Delete Account</a>
    </div>
    &copy; 2026 Interval Insights
  </footer>
</body>
</html>`;
}

function wrapTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

async function renderMarkdownPage(title: string, mdFileName: string): Promise<string> {
  const markdown = await Bun.file(new URL(`../${mdFileName}`, import.meta.url).pathname).text();
  const body = wrapTables(await marked.parse(markdown, { gfm: true }));
  return shell(title, body);
}

function deleteAccountContent(): string {
  return `
    <h1>Delete your Interval Insights account</h1>
    <p class="lead">
      This page explains how to request deletion of your <strong>Interval Insights</strong> account
      and the data associated with it, and what happens to that data once you do.
    </p>
    <p class="meta">
      App: <strong>Interval Insights</strong> &middot; Developer: <strong>Carl Valdemar Ebbesen</strong>
    </p>

    <div class="callout">
      <h3>Delete your account from the app (recommended)</h3>
      <ol class="steps">
        <li>Open the <strong>Interval Insights</strong> app and sign in.</li>
        <li>Go to <strong>Settings</strong>.</li>
        <li>Tap <strong>Delete account</strong> and confirm.</li>
      </ol>
      <p style="margin-bottom:0">
        Your account and all associated data are deleted immediately, and the app's access to your
        Strava account is revoked.
      </p>
    </div>

    <h2>Prefer to request it by email?</h2>
    <p>
      If you can no longer sign in to the app, email
      <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from the address linked to your account and
      ask us to delete it. We action verified deletion requests within <strong>one month</strong>, as
      required by GDPR Art&nbsp;12(3).
    </p>

    <h2>What gets deleted</h2>
    <p>Deleting your account permanently removes the following from our database:</p>
    <ul>
      <li>Your user record (profile and settings)</li>
      <li>All imported Strava activities and their analysis results</li>
      <li>All interval segments and workout-structure data</li>
      <li>Detected health events (injuries / illnesses)</li>
      <li>Your gear and gear defaults</li>
      <li>Your coaching-chat history</li>
      <li>Stored heart-rate data, if you had heart-rate processing enabled</li>
    </ul>
    <p>
      We also revoke the Service's Strava authorization and clear the Strava and intervals.icu
      connection tokens held for your account.
    </p>

    <h2>What may be retained, and for how long</h2>
    <p>
      A limited amount of data may be kept after deletion, only where necessary and for no longer than
      stated below:
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Data</th><th>Retention</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Residual copies inside routine encrypted backups</td>
            <td>Until the backup rotation purges them; not restored except for security, disaster
            recovery, or legal compliance</td>
          </tr>
          <tr>
            <td>Basic account information (email, name), where kept for dispute resolution</td>
            <td>Up to 24 months after account closure</td>
          </tr>
          <tr>
            <td>Support correspondence</td>
            <td>Up to 24 months from ticket closure</td>
          </tr>
          <tr>
            <td>Records we are legally required to keep</td>
            <td>Only for as long as the law requires</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p>
      Full details are in our
      <a href="/privacy-policy">Privacy Policy</a> (see the <em>Retention</em> and
      <em>Deletion of Your Personal Data</em> sections).
    </p>

    <h2>Data held by third parties</h2>
    <p>
      Deleting your Interval Insights account does not delete data held in your own
      <strong>Strava</strong> or <strong>intervals.icu</strong> accounts. To remove data there, manage
      those accounts directly (for Strava: Settings → My Apps → Revoke Access).
    </p>

    <h2>Questions</h2>
    <p>
      Contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for anything related to your
      account or data.
    </p>
  `;
}

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
} as const;

export function registerWebPages<E extends Env>(app: Hono<E>): void {
  app.get("/privacy-policy", async () => {
    const html = await renderMarkdownPage("Privacy Policy", "privacy_policy.md");
    return new Response(html, { headers: HTML_HEADERS });
  });

  app.get("/terms-of-service", async () => {
    const html = await renderMarkdownPage("Terms of Service", "terms_of_service.md");
    return new Response(html, { headers: HTML_HEADERS });
  });

  app.get("/display/delete-account", () => {
    const html = shell("Delete Account", deleteAccountContent());
    return new Response(html, { headers: HTML_HEADERS });
  });
}
