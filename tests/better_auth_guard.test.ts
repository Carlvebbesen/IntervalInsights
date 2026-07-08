// Focused dual-auth tests: the REAL authGuard (not the test_app stub) with a
// real Better Auth instance against the disposable test Postgres. Verifies the
// Phase 2 acceptance criteria: a Better Auth OTP sign-in yields a bearer token
// that resolves an app user; a legacy Clerk token still resolves; both land on
// the same users row for a backfilled user.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../src/auth";
import { logger } from "../src/logger";
import { authGuard } from "../src/middlewares/auth_middleware";
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

const fetchApp = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init), { db });

async function signInWithOtp(email: string): Promise<string> {
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
  const token = signInRes.headers.get("set-auth-token");
  if (!token) throw new Error("no set-auth-token header on sign-in response");
  return token;
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
