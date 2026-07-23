import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  __resetQuotaStore,
  ANALYSIS_START_DAILY_MAX,
  ANALYSIS_START_QUOTA,
  consumeQuota,
} from "../src/middlewares/quota_middleware";
import {
  NoPendingInterruptError,
  ResumeValidationError,
} from "../src/services/analysis_service";
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

  // Dedicated user: the batch route acts on ALL of a user's `initial` rows, so
  // rows seeded by the tests above must stay out of scope.
  describe("POST /auto-complete-all", () => {
    let batchUser: { id: string; clerkId: string };
    let nonInitialPendingId: number;
    let nonInitialErrorId: number;
    // Ascending-id order (creation order): outdoor EASY, indoor interval, outdoor interval.
    let initialIds: number[] = [];
    let indoorIntervalId: number;

    beforeAll(async () => {
      batchUser = await createTestUser({ role: "premium" });
      nonInitialPendingId = (
        await insertActivity(batchUser.id, { title: "Still pending", analysisStatus: "pending" })
      ).id;
      nonInitialErrorId = (
        await insertActivity(batchUser.id, { title: "Errored", analysisStatus: "error" })
      ).id;
    });

    afterAll(async () => {
      await deleteTestUser(batchUser.id);
    });

    const batchIdentity = () => ({
      userId: batchUser.id,
      clerkUserId: batchUser.clerkId,
      role: "premium" as const,
    });

    const postAll = (body?: string) =>
      app.fetch(
        new Request("http://test/api/v1/agents/auto-complete-all", {
          method: "POST",
          ...(body !== undefined
            ? { headers: { "Content-Type": "application/json" }, body }
            : {}),
        }),
      );

    it("returns empty arrays when no activity is `initial` (accepts an empty {} body)", () =>
      withIdentity(batchIdentity(), async () => {
        const res = await postAll("{}");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ completed: [], skipped: [] });
      }));

    it("completes every initial row sequentially — indoor interval-type included (lock override)", () =>
      withIdentity(batchIdentity(), async () => {
        const outdoorEasy = await insertActivity(batchUser.id, {
          title: "Outdoor easy",
          analysisStatus: "initial",
          trainingType: "EASY",
        });
        const indoorInterval = await insertActivity(batchUser.id, {
          title: "Treadmill intervals",
          analysisStatus: "initial",
          trainingType: "SHORT_INTERVALS",
          indoor: true,
        });
        const outdoorInterval = await insertActivity(batchUser.id, {
          title: "Track intervals",
          analysisStatus: "initial",
          trainingType: "LONG_INTERVALS",
        });
        initialIds = [outdoorEasy.id, indoorInterval.id, outdoorInterval.id];
        indoorIntervalId = indoorInterval.id;

        const calledWith: number[] = [];
        analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
          calledWith.push(args[2] as number);
        };
        try {
          const res = await postAll();
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.completed).toEqual(initialIds);
          expect(body.skipped).toEqual([]);
          expect(body.completed).toContain(indoorIntervalId);
          // Sequential, oldest first; non-initial rows never reach the service.
          expect(calledWith).toEqual(initialIds);
          expect(calledWith).not.toContain(nonInitialPendingId);
          expect(calledWith).not.toContain(nonInitialErrorId);
        } finally {
          analysisServiceMock.reset();
        }
      }));

    it("skips a structureless interval draft as no_structure while the rest complete", () =>
      withIdentity(batchIdentity(), async () => {
        const structureless = initialIds[1];
        analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
          if (args[2] === structureless) {
            throw new ResumeValidationError("Define an interval structure before completing");
          }
        };
        try {
          const res = await postAll();
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.completed).toEqual([initialIds[0], initialIds[2]]);
          expect(body.skipped).toEqual([{ activityId: structureless, reason: "no_structure" }]);
        } finally {
          analysisServiceMock.reset();
        }
      }));

    it("counts a raced concurrent resume (NoPendingInterrupt) as completed", () =>
      withIdentity(batchIdentity(), async () => {
        const raced = initialIds[0];
        analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
          if (args[2] === raced) {
            throw new NoPendingInterruptError("thread has no pending interrupt");
          }
        };
        try {
          const res = await postAll();
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.completed).toEqual(initialIds);
          expect(body.skipped).toEqual([]);
        } finally {
          analysisServiceMock.reset();
        }
      }));

    it("completes exactly the remaining quota and skips the overflow as quota_exhausted", () =>
      withIdentity(batchIdentity(), async () => {
        __resetQuotaStore();
        for (let i = 0; i < ANALYSIS_START_DAILY_MAX - 2; i++) {
          consumeQuota(ANALYSIS_START_QUOTA, ANALYSIS_START_DAILY_MAX, batchUser.id);
        }
        try {
          const res = await postAll();
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.completed).toEqual([initialIds[0], initialIds[1]]);
          expect(body.skipped).toEqual([
            { activityId: initialIds[2], reason: "quota_exhausted" },
          ]);
        } finally {
          __resetQuotaStore();
        }
      }));
  });
});
