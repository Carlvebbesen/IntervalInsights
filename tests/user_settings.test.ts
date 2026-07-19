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
          paceProgression: "mild",
          thresholdPaceMps: null,
          lthr: null,
          restingHr: null,
          ftp: null,
          sex: null,
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
          paceProgression: "mild",
          thresholdPaceMps: null,
          lthr: null,
          restingHr: null,
          ftp: null,
          sex: null,
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

  it("PATCH /api/v1/user/settings persists paceProgression and rejects an invalid value", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const set = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paceProgression: "aggressive" }),
          }),
        );
        expect(set.status).toBe(200);
        expect(await set.json()).toMatchObject({ paceProgression: "aggressive" });

        const settingsRow = await getOrCreateUserSettings(getDb(), user.id);
        expect(settingsRow.paceProgression).toBe("aggressive");

        const bad = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paceProgression: "turbo" }),
          }),
        );
        expect(bad.status).toBe(400);
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

  it("GET /api/v1/user seeds a fresh settings row from legacy users HR columns", async () => {
    const user = await createTestUser({ role: "premium", maxHeartRate: 185, processHeartRate: true });
    try {
      await withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const res = await app.fetch(new Request("http://test/api/v1/user"));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.maxHeartRate).toBe(185);
        expect(body.processHeartRate).toBe(true);
        expect(body.settings.maxHeartRate).toBe(185);
        expect(body.settings.processHeartRate).toBe(true);
      });
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("PATCH /api/v1/user/settings roundtrips the threshold fields, then clears them", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const set = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              thresholdPaceMps: 3.5,
              lthr: 165,
              restingHr: 48,
              ftp: 260,
              sex: "female",
            }),
          }),
        );
        expect(set.status).toBe(200);
        expect(await set.json()).toMatchObject({
          thresholdPaceMps: 3.5,
          lthr: 165,
          restingHr: 48,
          ftp: 260,
          sex: "female",
        });

        const clear = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              thresholdPaceMps: null,
              lthr: null,
              restingHr: null,
              ftp: null,
              sex: null,
            }),
          }),
        );
        expect(clear.status).toBe(200);
        const cleared = await clear.json();
        expect(cleared.thresholdPaceMps).toBeNull();
        expect(cleared.lthr).toBeNull();
        expect(cleared.restingHr).toBeNull();
        expect(cleared.ftp).toBeNull();
        expect(cleared.sex).toBeNull();
      }),
    ));

  it("PATCH /api/v1/user/settings rejects out-of-bounds threshold fields", () =>
    withFreshUser((user) =>
      withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        for (const bad of [
          { thresholdPaceMps: 20 },
          { thresholdPaceMps: -1 },
          { lthr: 40 },
          { lthr: 300 },
          { restingHr: 10 },
          { ftp: 10 },
          { ftp: 1000 },
          { sex: "other" },
        ]) {
          const res = await app.fetch(
            new Request("http://test/api/v1/user/settings", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(bad),
            }),
          );
          expect(res.status).toBe(400);
        }
      }),
    ));

  it("first-ever PATCH /api/v1/user/settings preserves legacy HR columns seeded into the new row", async () => {
    const user = await createTestUser({ role: "premium", maxHeartRate: 185, processHeartRate: true });
    try {
      await withIdentity({ userId: user.id, clerkUserId: user.clerkId, role: "premium" }, async () => {
        const res = await app.fetch(
          new Request("http://test/api/v1/user/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ waitForStravaUpdate: false }),
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.maxHeartRate).toBe(185);
        expect(body.processHeartRate).toBe(true);
        expect(body.waitForStravaUpdate).toBe(false);
      });
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
