// Focused dual-auth tests: the REAL authGuard (not the test_app stub) with a
// real Better Auth instance against the disposable test Postgres. Verifies the
// Phase 2 acceptance criteria: a Better Auth OTP sign-in yields a bearer token
// that resolves an app user; a legacy Clerk token still resolves; both land on
// the same users row for a backfilled user.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { auth } from "../src/auth";
import { AppError } from "../src/error";
import { logger } from "../src/logger";
import { authGuard } from "../src/middlewares/auth_middleware";
import adminRouter from "../src/routers/admin_router";
import { users } from "../src/schema";
import type { TGlobalEnv } from "../src/types/IRouters";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { clerkAuthMock, clerkUsersMock, otpCapture } from "./setup";

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
app.get("/api/whoami", (c) =>
  c.json({ userId: c.get("userId"), clerkUserId: c.get("clerkUserId"), role: c.get("role") }),
);
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

async function signInResponse(email: string): Promise<Response> {
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
  clerkAuthMock.reset();
  clerkUsersMock.reset();
  otpCapture.last = null;
});

afterAll(async () => {
  for (const id of createdUserIds) await deleteTestUser(id);
});

describe("dual-auth guard", () => {
  it("rejects a request with no credentials", async () => {
    clerkAuthMock.getAuth = () => null;
    const res = await fetchApp("/api/whoami");
    expect(res.status).toBe(401);
  });

  it("Better Auth OTP sign-in yields a bearer token that resolves an app user", async () => {
    clerkAuthMock.getAuth = () => null; // no Clerk fallback — BA path only
    const email = `ba-signup-${randomUUID()}@example.test`;

    const token = await signInWithOtp(email);
    const res = await fetchApp("/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; clerkUserId: string | null; role: string };
    createdUserIds.push(body.userId);

    // Auto-registered (open sign-up): new row, guest role, no clerkId, verified email.
    expect(body.role).toBe("guest");
    expect(body.clerkUserId).toBeNull();
    const row = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
    expect(row?.email).toBe(email);
    expect(row?.emailVerified).toBe(true);
    expect(row?.clerkId).toBeNull();
  });

  it("legacy Clerk token still resolves and lazy-create is enriched with email", async () => {
    const clerkId = `test_clerk_${randomUUID()}`;
    const email = `clerk-lazy-${randomUUID()}@example.test`;
    clerkAuthMock.getAuth = () => ({ userId: clerkId });
    clerkUsersMock.getUser = async () => ({
      primaryEmailAddress: { emailAddress: email, verification: { status: "verified" } },
      emailAddresses: [{ emailAddress: email, verification: { status: "verified" } }],
      firstName: "Lazy",
      lastName: "Created",
    });

    const res = await fetchApp("/api/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; clerkUserId: string | null };
    createdUserIds.push(body.userId);
    expect(body.clerkUserId).toBe(clerkId);

    const row = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
    expect(row?.email).toBe(email);
    expect(row?.name).toBe("Lazy Created");
    expect(row?.emailVerified).toBe(true);
  });

  it("Clerk lazy-create survives an email collision (creates the row without email)", async () => {
    // A BA-native row already owns the email (e.g. deleted account re-registered
    // via OTP); the old device's Clerk session must not 500 — it gets a fresh
    // email-less row instead.
    const email = `collision-${randomUUID()}@example.test`;
    clerkAuthMock.getAuth = () => null;
    const token = await signInWithOtp(email);
    const baRes = await fetchApp("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
    const baUserId = ((await baRes.json()) as { userId: string }).userId;
    createdUserIds.push(baUserId);

    const clerkId = `test_clerk_${randomUUID()}`;
    clerkAuthMock.getAuth = () => ({ userId: clerkId });
    clerkUsersMock.getUser = async () => ({
      primaryEmailAddress: { emailAddress: email, verification: { status: "verified" } },
      emailAddresses: [{ emailAddress: email, verification: { status: "verified" } }],
      firstName: "Collision",
      lastName: "Case",
    });

    const res = await fetchApp("/api/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    createdUserIds.push(body.userId);
    expect(body.userId).not.toBe(baUserId);
    const row = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
    expect(row?.clerkId).toBe(clerkId);
    expect(row?.email).toBeNull();
  });

  it("Clerk and Better Auth resolve a backfilled user to the same row", async () => {
    // Simulate a Phase 3-backfilled user: existing Clerk row with email set.
    const seeded = await createTestUser({ strava: false, intervals: false });
    createdUserIds.push(seeded.id);
    const email = `backfilled-${randomUUID()}@example.test`;
    await db
      .update(users)
      .set({ email, name: "Backfilled User", emailVerified: true })
      .where(eq(users.id, seeded.id));

    // Clerk path.
    clerkAuthMock.getAuth = () => ({ userId: seeded.clerkId });
    const clerkRes = await fetchApp("/api/whoami");
    expect(clerkRes.status).toBe(200);
    const clerkBody = (await clerkRes.json()) as { userId: string };
    expect(clerkBody.userId).toBe(seeded.id);

    // Better Auth path: OTP sign-in with the backfilled email matches the SAME row.
    clerkAuthMock.getAuth = () => null;
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

  it("signs in with the fixed code and auto-creates a guest", async () => {
    clerkAuthMock.getAuth = () => null;
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
    clerkAuthMock.getAuth = () => null;
    const signInRes = await reviewSignIn("Store-Review@Test.Local");
    expect(signInRes.status).toBe(200);
    const token = signInRes.headers.get("set-auth-token");
    if (!token) throw new Error("no set-auth-token header");
    const res = await fetchApp("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    createdUserIds.push(((await res.json()) as { userId: string }).userId);
  });

  it("does not leak the fixed code to a normal email", async () => {
    clerkAuthMock.getAuth = () => null;
    const email = `normal-${randomUUID()}@example.test`;
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
    clerkAuthMock.getAuth = () => null;
    const cookie = cookieHeaderFrom(await signInResponse(`csrf-403-${randomUUID()}@example.test`));

    const res = await fetchApp("/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("sign-out with a session cookie and expo-origin passes the check", async () => {
    clerkAuthMock.getAuth = () => null;
    const cookie = cookieHeaderFrom(await signInResponse(`csrf-signout-${randomUUID()}@example.test`));

    const res = await fetchApp("/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: cookie, "expo-origin": "intervalinsights://" },
    });
    expect(res.status).toBe(200);
  });

  it("send-verification-otp with a session cookie and expo-origin passes (the call that failed on device)", async () => {
    clerkAuthMock.getAuth = () => null;
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
    clerkAuthMock.getAuth = () => null;
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
