import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };

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
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

describe("/api/dashboard", () => {
  it("GET / returns summary + graph + averages + wellness", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/dashboard"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.summary.thisWeekKm).toBe("number");
      expect(Array.isArray(body.graph)).toBe(true);
      expect(typeof body.averages.avgSessionsPerWeek).toBe("number");
      // wellness is null when intervals not linked (mocked default)
      expect(body.wellness).toBeNull();
    }));

  it("GET /training-summary returns discriminated result", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/dashboard/training-summary"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("not_linked");
      expect(body.data).toBeNull();
    }));

  it("GET /wellness validates date range", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/dashboard/wellness?oldest=bad&newest=2026-01-01"),
      );
      expect(res.status).toBe(400);
    }));

  it("GET /wellness returns discriminated result", () =>
    withIdentity(identity(), async () => {
      const today = new Date().toISOString().slice(0, 10);
      const lastWeek = new Date(Date.now() - 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const res = await app.fetch(
        new Request(
          `http://test/api/dashboard/wellness?oldest=${lastWeek}&newest=${today}`,
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(["ok", "not_linked", "no_data"]).toContain(body.status);
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
        new Request(`http://test/api/dashboard/week/${weekStart}`),
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
        new Request("http://test/api/dashboard/week/not-a-date"),
      );
      expect(res.status).toBe(400);
    }));
});
