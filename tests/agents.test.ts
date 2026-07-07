import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let activityId: number;
let stravaActivityId: number;

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  const seeded = await insertActivity(user.id, {
    title: "Pending Run",
    analysisStatus: "pending",
  });
  activityId = seeded.id;
  stravaActivityId = seeded.stravaActivityId;
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

describe("/api/agents", () => {
  it("GET /pending returns array of pending activities", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/agents/pending"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      // Our pending activity should show up
      expect(body.find((a: { id: number }) => a.id === activityId)).toBeDefined();
    }));

  it("POST /start-analysis succeeds (analysis service mocked)", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/agents/start-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activityId, stravaActivityId }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    }));

  it("POST /resume-analysis succeeds with valid payload", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/agents/resume-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            activityId,
            notes: "felt easy",
            sets: [],
            trainingType: "EASY",
            feeling: 3,
          }),
        }),
      );
      expect(res.status).toBe(200);
    }));

  it("POST /parse-intervals returns [] for stub agent", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/agents/parse-intervals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "6x400m @ 90s rest" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }));

  it("POST /parse-intervals rejects too-short text", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/agents/parse-intervals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "x" }),
        }),
      );
      expect(res.status).toBe(400);
    }));
});
