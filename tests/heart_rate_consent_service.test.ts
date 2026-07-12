import { afterAll, describe, expect, it } from "bun:test";
import { userHasHeartRateConsent } from "../src/services/heart_rate_consent_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

// The ingest gate: analysis-settings wave 2 moved the read from
// users.processHeartRate to user_settings — this must resolve identically.

const db = getDb();

afterAll(async () => {
  await closePool();
});

describe("userHasHeartRateConsent", () => {
  it("returns true for a user seeded with processHeartRate: true", async () => {
    const user = await createTestUser({ processHeartRate: true });
    try {
      expect(await userHasHeartRateConsent(db, user.id)).toBe(true);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("returns false for a user seeded with processHeartRate: false", async () => {
    const user = await createTestUser({ processHeartRate: false });
    try {
      expect(await userHasHeartRateConsent(db, user.id)).toBe(false);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("materializes and seeds the user_settings row on first check (lazy getOrCreate)", async () => {
    const user = await createTestUser({ processHeartRate: true });
    try {
      const { userSettings } = await import("../src/schema");
      const { eq } = await import("drizzle-orm");
      const before = await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, user.id),
      });
      expect(before).toBeUndefined();

      expect(await userHasHeartRateConsent(db, user.id)).toBe(true);

      const after = await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, user.id),
      });
      expect(after?.processHeartRate).toBe(true);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
