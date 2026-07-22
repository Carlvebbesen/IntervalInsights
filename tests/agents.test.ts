import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { NoPendingInterruptError } from "../src/services/analysis_service";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { analysisServiceMock } from "./setup";

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
      expect(body.analysisStatus).toBe("ongoing_init");
    }));

  it("POST /start-analysis reports the blocking status when the claim is declined", () =>
    withIdentity(identity(), async () => {
      analysisServiceMock.claimForAnalysis = async () => false;
      try {
        const res = await app.fetch(
          new Request("http://test/api/v1/agents/start-analysis", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId, stravaActivityId }),
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.analysisStatus).toBe("pending");
      } finally {
        analysisServiceMock.reset();
      }
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

  it("POST /auto-complete rejects a non-initial activity with the error envelope", () =>
    withIdentity(identity(), async () => {
      // The seeded activity is `pending`, not `initial` (ready to complete).
      const res = await app.fetch(
        new Request("http://test/api/v1/agents/auto-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activityId }),
        }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
    }));

  it("POST /auto-complete treats a raced concurrent resume (NoPendingInterrupt) as success", () =>
    withIdentity(identity(), async () => {
      const seeded = await insertActivity(user.id, {
        title: "Ready run",
        analysisStatus: "initial",
      });
      analysisServiceMock.autoCompleteAnalysis = async () => {
        throw new NoPendingInterruptError("thread has no pending interrupt");
      };
      try {
        const res = await app.fetch(
          new Request("http://test/api/v1/agents/auto-complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId: seeded.id }),
          }),
        );
        expect(res.status).toBe(200);
        expect((await res.json()).success).toBe(true);
      } finally {
        analysisServiceMock.reset();
      }
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

  // A migrated user has `users.stravaId` set but no token in the vault. /pending
  // must still load (soft strava middleware), while analysis mutations that need
  // a live token stay hard-gated with 403.
  describe("without a linked Strava token", () => {
    let tokenless: { id: string; clerkId: string };
    let pendingId: number;

    beforeAll(async () => {
      tokenless = await createTestUser({ role: "premium", strava: false });
      const seeded = await insertActivity(tokenless.id, {
        title: "Tokenless Pending Run",
        analysisStatus: "pending",
      });
      pendingId = seeded.id;
    });

    afterAll(async () => {
      await deleteTestUser(tokenless.id);
    });

    const tokenlessIdentity = () => ({
      userId: tokenless.id,
      clerkUserId: tokenless.clerkId,
      role: "premium" as const,
    });

    it("GET /pending still returns 200", () =>
      withIdentity(tokenlessIdentity(), async () => {
        const res = await app.fetch(new Request("http://test/api/v1/agents/pending"));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.find((a: { id: number }) => a.id === pendingId)).toBeDefined();
      }));

    it("POST /start-analysis is rejected with 403", () =>
      withIdentity(tokenlessIdentity(), async () => {
        const res = await app.fetch(
          new Request("http://test/api/v1/agents/start-analysis", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId: pendingId }),
          }),
        );
        expect(res.status).toBe(403);
      }));
  });
});
