import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { activities } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

describe("contract: nullable Strava id + pending startDateLocal", () => {
  it("persists an activity with a null Strava id (intervals.icu-only)", async () => {
    const [row] = await getDb()
      .insert(activities)
      .values({
        userId: user.id,
        stravaActivityId: null,
        intervalsIcuId: "i-only-1",
        title: "Intervals Only",
        sportType: "Run",
        distance: 5000,
        movingTime: 1500,
        startDateLocal: new Date("2026-05-02T09:00:00Z"),
        analysisStatus: "completed",
        indoor: false,
      })
      .returning();

    expect(row.stravaActivityId).toBeNull();
    expect(row.intervalsIcuId).toBe("i-only-1");
  });

  it("GET /api/agents/pending returns startDateLocal and a nullable stravaId", () =>
    withIdentity(identity(), async () => {
      await insertActivity(user.id, {
        title: "Pending With Date",
        analysisStatus: "pending",
        startDateLocal: new Date("2026-05-03T07:30:00Z"),
      });
      await getDb()
        .insert(activities)
        .values({
          userId: user.id,
          stravaActivityId: null,
          intervalsIcuId: "i-pending-2",
          title: "Pending Intervals Only",
          sportType: "Run",
          distance: 4000,
          movingTime: 1200,
          startDateLocal: new Date("2026-05-04T06:00:00Z"),
          analysisStatus: "pending",
          indoor: false,
        });

      const res = await app.fetch(new Request("http://test/api/agents/pending"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);

      for (const a of body as Array<{ startDateLocal: string }>) {
        expect(typeof a.startDateLocal).toBe("string");
        expect(Number.isNaN(Date.parse(a.startDateLocal))).toBe(false);
      }

      const nullStrava = (body as Array<{ title: string; stravaId: number | null }>).find(
        (a) => a.title === "Pending Intervals Only",
      );
      expect(nullStrava).toBeDefined();
      expect(nullStrava?.stravaId).toBeNull();
    }));
});
