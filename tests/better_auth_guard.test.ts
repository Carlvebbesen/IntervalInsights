// Focused auth tests: the REAL authGuard (not the test_app stub) with a real
// Better Auth instance against the disposable test Postgres. Better Auth is the
// only provider — an OTP sign-in yields a bearer token that resolves an app
// user, and anything else is 401 with no row lazy-created.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { auth, ensureReviewAccount } from "../src/auth";
import { AppError } from "../src/error";
import { logger } from "../src/logger";
import { authGuard } from "../src/middlewares/auth_middleware";
import adminRouter from "../src/routers/admin_router";
import { users } from "../src/schema";
import type { TGlobalEnv } from "../src/types/IRouters";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { otpCapture } from "./setup";

const db = getDb();
const createdUserIds: string[] = [];

const app = new Hono<TGlobalEnv>();
app.use("*", async (c, next) => {
  c.set("logger", logger);
  c.set("requestId", "test-req");
  await next();
});
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.use("/api/*", authGuard);
app.get("/api/whoami", (c) => c.json({ userId: c.get("userId"), role: c.get("role") }));
// Real admin router behind the REAL guard, so role checks resolve from the DB row.
app.route("/api/admin", adminRouter);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  }
  throw err;
});

const fetchApp = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init), { db });

// Sign-in no longer auto-registers (disableSignUp: true) — a fresh user must
// go through the explicit sign-up endpoint first. Existing emails no-op.
async function signUp(email: string, name = email.split("@")[0]): Promise<Response> {
  const res = await fetchApp("/api/auth/sign-up/email-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  expect(res.status).toBe(200);
  return res;
}

async function signInResponse(email: string): Promise<Response> {
  await signUp(email);
  const sendRes = await fetchApp("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  expect(sendRes.status).toBe(200);
  expect(otpCapture.last?.email).toBe(email);
  const otp = otpCapture.last?.otp;
  if (!otp) throw new Error("no OTP captured");

  const signInRes = await fetchApp("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp }),
  });
  expect(signInRes.status).toBe(200);
  return signInRes;
}

async function signInWithOtp(email: string): Promise<string> {
  const signInRes = await signInResponse(email);
  const token = signInRes.headers.get("set-auth-token");
  if (!token) throw new Error("no set-auth-token header on sign-in response");
  return token;
}

// Rebuilds a `Cookie:` request header from a sign-in response's Set-Cookie(s) —
// name=value pairs only, dropping attributes (Path/HttpOnly/…).
function cookieHeaderFrom(res: Response): string {
  const setCookies = res.headers.getSetCookie();
  if (setCookies.length === 0) throw new Error("no set-cookie on sign-in response");
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

afterEach(() => {
  otpCapture.last = null;
});

afterAll(async () => {
  for (const id of createdUserIds) await deleteTestUser(id);
});

describe("auth guard", () => {
  it("rejects a request with no credentials", async () => {
    const res = await fetchApp("/api/whoami");
    expect(res.status).toBe(401);
  });

  it("explicit sign-up + OTP verify yields a guest bearer user with the supplied name", async () => {
    const email = `ba-signup-${randomUUID()}@example.test`;
    const name = "New Signup";

    // Explicit sign-up creates the row (emailVerified false); the first OTP
    // verify below flips it true. No open auto-register anymore.
    await signUp(email, name);
    const preVerify = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(preVerify?.name).toBe(name);
    expect(preVerify?.emailVerified).toBe(false);

    const token = await signInWithOtp(email);
    const res = await fetchApp("/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; role: string };
    createdUserIds.push(body.userId);

    expect(body.role).toBe("guest");
    const row = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
    expect(row?.email).toBe(email);
    expect(row?.name).toBe(name); // sign-up name preserved (sign-in never overwrites it)
    expect(row?.emailVerified).toBe(true);
  });

  it("an unrecognised bearer token is 401 and lazy-creates no user row", async () => {
    // The guard has no lazy-create: an account must already exist via sign-up,
    // so an unknown token can never conjure one.
    const [{ before }] = await db.select({ before: count() }).from(users);
    const res = await fetchApp("/api/whoami", {
      headers: { Authorization: `Bearer not-a-real-session-${randomUUID()}` },
    });
    expect(res.status).toBe(401);
    const [{ after }] = await db.select({ after: count() }).from(users);
    expect(after).toBe(before);
  });

  it("a credential-less request for an existing user's email is 401 and forks no row", async () => {
    // Guards the email-collision case: no second, email-less row may appear.
    const email = `collision-${randomUUID()}@example.test`;
    const token = await signInWithOtp(email);
    const baRes = await fetchApp("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
    const baUserId = ((await baRes.json()) as { userId: string }).userId;
    createdUserIds.push(baUserId);

    const res = await fetchApp("/api/whoami");
    expect(res.status).toBe(401);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(baUserId);
  });

  it("Better Auth resolves a pre-existing users row and keeps its stored role", async () => {
    // A migrated user: the row already exists (premium) before any Better Auth
    // sign-in. OTP sign-in must match it rather than register a fresh guest.
    const seeded = await createTestUser({ strava: false, intervals: false });
    createdUserIds.push(seeded.id);
    const email = `backfilled-${randomUUID()}@example.test`;
    await db
      .update(users)
      .set({ email, name: "Backfilled User", emailVerified: true })
      .where(eq(users.id, seeded.id));

    // No session ⇒ 401; there is no second provider to fall back to.
    expect((await fetchApp("/api/whoami")).status).toBe(401);

    const token = await signInWithOtp(email);
    const baRes = await fetchApp("/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(baRes.status).toBe(200);
    const baBody = (await baRes.json()) as { userId: string; role: string };
    expect(baBody.userId).toBe(seeded.id);
    expect(baBody.role).toBe("premium"); // role came from the existing row, not re-registered
  });
});

// Store-review demo account (REVIEW_ACCOUNT_EMAIL/OTP in tests/setup.ts): a
// fixed sign-in code for app-store reviewers, email suppressed. Everyone else
// keeps random emailed OTPs.
describe("review account (fixed OTP)", () => {
  const reviewEmail = "store-review@test.local";
  const reviewOtp = "731409";

  // OTP auto-register is gone, so the review row is pre-seeded at boot instead
  // of being created on first verify (mirrors src/index.ts's prod call site).
  beforeAll(async () => {
    await ensureReviewAccount();
  });

  async function reviewSignIn(email: string): Promise<Response> {
    const sendRes = await fetchApp("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(sendRes.status).toBe(200);
    // Email suppressed — no OTP is dispatched for the review address.
    expect(otpCapture.last).toBeNull();
    return fetchApp("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: reviewOtp }),
    });
  }

  it("signs in with the fixed code against the pre-seeded guest row", async () => {
    const signInRes = await reviewSignIn(reviewEmail);
    expect(signInRes.status).toBe(200);
    const token = signInRes.headers.get("set-auth-token");
    if (!token) throw new Error("no set-auth-token header");

    const res = await fetchApp("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; role: string };
    createdUserIds.push(body.userId);
    expect(body.role).toBe("guest");
  });

  it("is case-insensitive on the review email", async () => {
    const signInRes = await reviewSignIn("Store-Review@Test.Local");
    expect(signInRes.status).toBe(200);
    const token = signInRes.headers.get("set-auth-token");
    if (!token) throw new Error("no set-auth-token header");
    const res = await fetchApp("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    createdUserIds.push(((await res.json()) as { userId: string }).userId);
  });

  it("does not leak the fixed code to a normal email", async () => {
    const email = `normal-${randomUUID()}@example.test`;
    await signUp(email); // known email so send actually issues a code (disableSignUp)
    const sendRes = await fetchApp("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(sendRes.status).toBe(200);
    // A random code was emailed, and it is NOT the fixed review code.
    expect(otpCapture.last?.email).toBe(email);
    expect(otpCapture.last?.otp).not.toBe(reviewOtp);

    // The fixed code must not authenticate a normal email.
    const badRes = await fetchApp("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: reviewOtp }),
    });
    expect(badRes.status).toBe(400);
  });
});

// The 2026-07-08 device smoke test failed here: after the first sign-in the
// native cookie jar makes every later /api/auth POST carry the session cookie
// with no Origin, so Better Auth's cookie-triggered CSRF check 403s
// (MISSING_OR_NULL_ORIGIN). The expo-origin bridge in src/auth.ts fixes it.
// signInWithOtp authenticates via the set-auth-token bearer header and never
// replays the cookie, so these send Cookie: explicitly to exercise the check.
describe("cookie-triggered CSRF origin check (expo-origin bridge)", () => {
  it("sign-out with a session cookie and no origin is still rejected (CSRF intact)", async () => {
    const cookie = cookieHeaderFrom(await signInResponse(`csrf-403-${randomUUID()}@example.test`));

    const res = await fetchApp("/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("sign-out with a session cookie and expo-origin passes the check", async () => {
    const cookie = cookieHeaderFrom(await signInResponse(`csrf-signout-${randomUUID()}@example.test`));

    const res = await fetchApp("/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: cookie, "expo-origin": "intervalinsights://" },
    });
    expect(res.status).toBe(200);
  });

  it("send-verification-otp with a session cookie and expo-origin passes (the call that failed on device)", async () => {
    const cookie = cookieHeaderFrom(await signInResponse(`csrf-send-${randomUUID()}@example.test`));

    const res = await fetchApp("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "expo-origin": "intervalinsights://",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: `csrf-send-target-${randomUUID()}@example.test`, type: "sign-in" }),
    });
    expect(res.status).toBe(200);
  });
});

// A client can claim any role it likes in a request body; the stored users.role
// row (resolved by the real authGuard on every request) must stay authoritative.
describe("role escalation — stored role is authoritative", () => {
  async function signInFreshGuest(): Promise<{ token: string; userId: string }> {
    const token = await signInWithOtp(`escalation-${randomUUID()}@example.test`);
    const res = await fetchApp("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; role: string };
    createdUserIds.push(body.userId);
    expect(body.role).toBe("guest");
    return { token, userId: body.userId };
  }

  it("a guest sending role:admin to the admin API is rejected on the stored role", async () => {
    const { token, userId } = await signInFreshGuest();

    const res = await fetchApp(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(403);

    const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row?.role).toBe("guest");
  });

  it("update-user cannot change the stored role (input:false strips it)", async () => {
    const { token, userId } = await signInFreshGuest();

    const res = await fetchApp("/api/auth/update-user", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Spoofed Admin", role: "admin" }),
    });
    // Whether Better Auth strips the field (200) or rejects the body (400),
    // the stored role must be untouched.
    expect([200, 400]).toContain(res.status);

    const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row?.role).toBe("guest");

    const whoami = await fetchApp("/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await whoami.json()) as { role: string }).role).toBe("guest");
  });
});

// The explicit registration endpoint that replaced OTP auto-register. It is
// enumeration-safe: the same {success:true} whether the email is new or taken.
describe("sign-up endpoint (/sign-up/email-otp)", () => {
  it("creates a guest row (supplied name, emailVerified false)", async () => {
    const email = `signup-new-${randomUUID()}@example.test`;
    const res = await fetchApp("/api/auth/sign-up/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: "Fresh Name" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!row) throw new Error("expected sign-up to create a row");
    createdUserIds.push(row.id);
    expect(row.name).toBe("Fresh Name");
    expect(row.role).toBe("guest");
    expect(row.emailVerified).toBe(false);
  });

  it("existing email returns a byte-identical response and never touches the name", async () => {
    const email = `signup-dupe-${randomUUID()}@example.test`;
    const first = await fetchApp("/api/auth/sign-up/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: "Original Name" }),
    });
    const firstBody = await first.text();
    const created = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!created) throw new Error("expected first sign-up to create a row");
    createdUserIds.push(created.id);

    const second = await fetchApp("/api/auth/sign-up/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: "Attempted Overwrite" }),
    });
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(firstBody);

    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(row?.id).toBe(created.id); // no second row
    expect(row?.name).toBe("Original Name"); // name untouched by the repeat call
  });

  it("a signed-up email can then request a real OTP (known-email send delivers)", async () => {
    const email = `signup-then-send-${randomUUID()}@example.test`;
    await signUp(email, "Sender");

    const sendRes = await fetchApp("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(sendRes.status).toBe(200);
    expect(otpCapture.last?.email).toBe(email);
    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (row) createdUserIds.push(row.id);
  });
});

// disableSignUp: an unknown email must yield no code and no account — a sign-in
// attempt is indistinguishable from a wrong code, leaking nothing.
describe("sign-in enumeration protection (disableSignUp)", () => {
  it("unknown-email send returns 200 but issues no OTP", async () => {
    const email = `unknown-${randomUUID()}@example.test`;
    const sendRes = await fetchApp("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    expect(sendRes.status).toBe(200);
    expect(otpCapture.last).toBeNull(); // no code emitted, no account created
    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(row).toBeUndefined();
  });

  it("unknown-email verify is rejected as INVALID_OTP", async () => {
    const email = `unknown-verify-${randomUUID()}@example.test`;
    const res = await fetchApp("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: "000000" }),
    });
    expect(res.status).toBe(400);
    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(row).toBeUndefined();
  });
});
