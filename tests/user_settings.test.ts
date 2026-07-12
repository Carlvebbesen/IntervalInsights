import { afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { getOrCreateUserSettings } from "../src/repositories/user_settings_repository";
import { userSettings, users } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

afterAll(async () => {
  await closePool();
});

async function withFreshUser<T>(fn: (user: { id: string; clerkId: string }) => Promise<T>) {
  const user = await createTestUser({ role: "premium" });
  try {
    return await fn(user);
  } finally {
    await deleteTestUser(user.id);
  }
}

describe("/api/v1/user settings", () => {
  it("GET /api/v1/user materializes default settings for a user with no row yet", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const res = await app.fetch(new Request("http://test/api/v1/user"));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.settings).toEqual({
          waitForStravaUpdate: true,
          analysisReviewMode: "all",
          maxHeartRate: null,
          processHeartRate: false,
        });
        expect(body.maxHeartRate).toBeNull();
        expect(body.processHeartRate).toBe(false);
      }),
    ));

  it("PATCH /api/v1/user/settings changes only the sent fields and returns full settings", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const first = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ analysisReviewMode: "intervals_only" }),
          }),
        );
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({
          waitForStravaUpdate: true,
          analysisReviewMode: "intervals_only",
          maxHeartRate: null,
          processHeartRate: false,
        });

        const second = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ waitForStravaUpdate: false }),
          }),
        );
        expect(second.status).toBe(200);
        const secondBody = await second.json();
        expect(secondBody.waitForStravaUpdate).toBe(false);
        // Unrelated field set by the first PATCH must survive untouched.
        expect(secondBody.analysisReviewMode).toBe("intervals_only");
      }),
    ));

  it("PATCH /api/v1/user/settings rejects an empty body", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const res = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        );
        expect(res.status).toBe(400);
      }),
    ));

  it("legacy PATCH /api/v1/user with maxHeartRate dual-writes the settings row", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const res = await app.fetch(
          new Request("http://test/api/v1/user", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ maxHeartRate: 180 }),
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.maxHeartRate).toBe(180);
        expect(body.settings.maxHeartRate).toBe(180);

        const settingsRow = await getOrCreateUserSettings(getDb(), user.id);
        expect(settingsRow.maxHeartRate).toBe(180);

        const userRow = await getDb().query.users.findFirst({ where: eq(users.id, user.id) });
        expect(userRow?.maxHeartRate).toBe(180);
      }),
    ));

  it("concurrent getOrCreateUserSettings calls for a fresh user both succeed and yield one row", () =>
    withFreshUser(async (user) => {
      const db = getDb();
      const [a, b] = await Promise.all([
        getOrCreateUserSettings(db, user.id),
        getOrCreateUserSettings(db, user.id),
      ]);
      expect(a.userId).toBe(user.id);
      expect(b.userId).toBe(user.id);

      const rows = await db.select().from(userSettings).where(eq(userSettings.userId, user.id));
      expect(rows).toHaveLength(1);
    }));
});
