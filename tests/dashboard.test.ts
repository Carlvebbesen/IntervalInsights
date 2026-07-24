import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; email: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  // Seed a couple of activities in the last 7 days
  const now = new Date();
  await insertActivity(user.id, {
    title: "Today run",
    distance: 8000,
    movingTime: 2400,
    startDateLocal: now,
    trainingType: "EASY",
    sportType: "Run",
  });
  const yesterday = new Date(now.getTime() - 86_400_000);
  await insertActivity(user.id, {
    title: "Yesterday run",
    distance: 5000,
    movingTime: 1500,
    startDateLocal: yesterday,
    trainingType: "TEMPO",
    sportType: "Run",
  });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  role: "premium" as const,
});

describe("/api/dashboard", () => {
  it("GET / returns summary + graph + averages + wellness", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/dashboard"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.summary.thisWeekKm).toBe("number");
      expect(Array.isArray(body.graph)).toBe(true);
      expect(typeof body.averages.avgSessionsPerWeek).toBe("number");
      // wellness is null when intervals not linked (mocked default)
      expect(body.wellness).toBeNull();
    }));

  it("GET / resolves week boundaries against the client's local date", async () => {
    // Sunday 23:30 local (stored local-as-UTC). From the athlete's Sunday this
    // is "this week"; from their Monday it belongs to the previous week. The
    // server's UTC clock must not decide.
    const boundaryUser = await createTestUser({ role: "premium" });
    try {
      await insertActivity(boundaryUser.id, {
        title: "Sunday night run",
        distance: 8000,
        movingTime: 2400,
        startDateLocal: new Date("2026-06-28T23:30:00.000Z"),
        trainingType: "EASY",
        sportType: "Run",
      });
      const boundaryIdentity = {
        userId: boundaryUser.id,
        role: "premium" as const,
      };

      await withIdentity(boundaryIdentity, async () => {
        const sunday = await app.fetch(
          new Request("http://test/api/v1/dashboard?date=2026-06-28"),
        );
        expect(sunday.status).toBe(200);
        const sundayBody = await sunday.json();
        expect(sundayBody.summary.thisWeekKm).toBeCloseTo(8, 3);
        expect(sundayBody.summary.prevWeekKm).toBeCloseTo(0, 3);

        const monday = await app.fetch(
          new Request("http://test/api/v1/dashboard?date=2026-06-29"),
        );
        expect(monday.status).toBe(200);
        const mondayBody = await monday.json();
        expect(mondayBody.summary.thisWeekKm).toBeCloseTo(0, 3);
        expect(mondayBody.summary.prevWeekKm).toBeCloseTo(8, 3);
      });
    } finally {
      await deleteTestUser(boundaryUser.id);
    }
  });

  it("GET /training-summary returns discriminated result", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/dashboard/training-summary"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("not_linked");
      expect(body.data).toBeNull();
    }));

  it("GET /week/:weekStart returns week stats", () =>
    withIdentity(identity(), async () => {
      const today = new Date();
      const monday = new Date(today);
      monday.setUTCDate(
        today.getUTCDate() - ((today.getUTCDay() + 6) % 7),
      );
      const weekStart = monday.toISOString().slice(0, 10);
      const res = await app.fetch(
        new Request(`http://test/api/v1/dashboard/week/${weekStart}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.weekStart).toBe(weekStart);
      expect(typeof body.running.totalKm).toBe("number");
      expect(typeof body.intervals.count).toBe("number");
    }));

  it("GET /week/:weekStart rejects bad date", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/dashboard/week/not-a-date"),
      );
      expect(res.status).toBe(400);
    }));
});
