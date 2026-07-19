import { afterAll, describe, expect, it } from "bun:test";
import { raceEfforts } from "../src/repositories/pace_anchor_repository";
import { activities } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

afterAll(async () => {
  await closePool();
});

async function insertRace(userId: string, startDateLocal: Date, movingTime: number) {
  const db = getDb();
  await db.insert(activities).values({
    userId,
    stravaActivityId: Math.floor(Math.random() * 1e12),
    title: "race",
    sportType: "Run",
    trainingType: "RACE",
    distance: 10000,
    movingTime,
    startDateLocal,
    indoor: false,
  });
}

describe("effort queries as-of bounds", () => {
  it("excludes efforts after the until date (no look-ahead in historical anchors)", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await insertRace(user.id, new Date("2020-03-01T10:00:00"), 2400);
      await insertRace(user.id, new Date("2020-05-01T10:00:00"), 2300);
      await insertRace(user.id, new Date("2021-01-01T10:00:00"), 2000);

      const within = await raceEfforts(
        db,
        user.id,
        new Date("2020-01-01T00:00:00"),
        new Date("2020-06-01T00:00:00"),
      );
      expect(within.map((r) => r.durationSec).sort()).toEqual([2300, 2400]);

      const all = await raceEfforts(
        db,
        user.id,
        new Date("2020-01-01T00:00:00"),
        new Date("2022-01-01T00:00:00"),
      );
      expect(all.length).toBe(3);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
