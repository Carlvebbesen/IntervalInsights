import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  __resetQuotaStore,
  ANALYSIS_START_DAILY_MAX,
  ANALYSIS_START_QUOTA,
  consumeQuota,
} from "../src/middlewares/quota_middleware";
import * as analysisController from "../src/controllers/analysis_controller";
import {
  NoPendingInterruptError,
  ResumeValidationError,
} from "../src/services/analysis_service";
import { progressService, type SyncProgress } from "../src/services/progress_service";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { analysisServiceMock } from "./setup";

const app = buildTestApp(getPool());

let user: { id: string; email: string };
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
    let tokenless: { id: string; email: string };
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

    // Spy on the progress publisher to capture published SSE `sync` events.
    const captureSyncEvents = () => {
      const events: { userId: string; data: SyncProgress }[] = [];
      const orig = progressService.publish.bind(progressService);
      progressService.publish = async (userId, event) => {
        if (event.type === "sync") events.push({ userId, data: event.data });
        return orig(userId, event);
      };
      return {
        events,
        restore: () => {
          progressService.publish = orig;
        },
      };
    };

    const waitFor = async (cond: () => boolean, timeoutMs = 2000) => {
      const start = Date.now();
      while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // Seam for the detached-loop tests: run the batch to completion without HTTP.
    const runAll = async () => {
      const { targeted, run } = await analysisController.autoCompleteAllActivities(
        getDb(),
        "test-strava-token",
        batchUser.id,
      );
      await run();
      return targeted;
    };

    it("responds 202 {targeted: 0} with no detached work or sync events when nothing is initial (accepts {})", async () => {
      const capture = captureSyncEvents();
      try {
        await withIdentity(batchIdentity(), async () => {
          const res = await postAll("{}");
          expect(res.status).toBe(202);
          expect(await res.json()).toEqual({ targeted: 0 });
        });
        await new Promise((r) => setTimeout(r, 25));
        expect(capture.events).toEqual([]);
      } finally {
        capture.restore();
      }
    });

    it("responds 202 immediately, then the detached run completes every initial row — indoor interval included (lock override)", async () => {
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

      const capture = captureSyncEvents();
      const calledWith: number[] = [];
      analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
        calledWith.push(args[2] as number);
      };
      try {
        await withIdentity(batchIdentity(), async () => {
          const res = await postAll();
          expect(res.status).toBe(202);
          expect(await res.json()).toEqual({ targeted: 3 });
        });
        await waitFor(() => capture.events.some((e) => e.data.phase === "completed"));

        // Sequential, oldest first; indoor interval included; non-initial rows
        // never reach the service.
        expect(calledWith).toEqual(initialIds);
        expect(calledWith).toContain(indoorIntervalId);
        expect(calledWith).not.toContain(nonInitialPendingId);
        expect(calledWith).not.toContain(nonInitialErrorId);

        expect(capture.events.map((e) => e.userId)).toEqual([batchUser.id, batchUser.id]);
        expect(capture.events[0].data).toEqual({
          kind: "complete_all",
          phase: "started",
          title: "Complete all",
          messageKey: "pending_complete_all_toast_started",
          messageArgs: { count: "3" },
        });
        expect(capture.events[1].data).toEqual({
          kind: "complete_all",
          phase: "completed",
          title: "Complete all",
          messageKey: "pending_complete_all_toast_completed",
          messageArgs: { completed: "3" },
        });
      } finally {
        analysisServiceMock.reset();
        capture.restore();
      }
    });

    it("skips a structureless interval draft as no_structure while the rest complete", async () => {
      const structureless = initialIds[1];
      const capture = captureSyncEvents();
      analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
        if (args[2] === structureless) {
          throw new ResumeValidationError("Define an interval structure before completing");
        }
      };
      try {
        expect(await runAll()).toBe(3);
        expect(capture.events[0].data.phase).toBe("started");
        expect(capture.events[1].data).toEqual({
          kind: "complete_all",
          phase: "completed",
          title: "Complete all",
          messageKey: "pending_complete_all_toast_completed_skipped",
          messageArgs: { completed: "2", skipped: "1" },
        });
      } finally {
        analysisServiceMock.reset();
        capture.restore();
      }
    });

    it("counts a raced concurrent resume (NoPendingInterrupt) as completed", async () => {
      const raced = initialIds[0];
      const capture = captureSyncEvents();
      analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
        if (args[2] === raced) {
          throw new NoPendingInterruptError("thread has no pending interrupt");
        }
      };
      try {
        expect(await runAll()).toBe(3);
        expect(capture.events[1].data).toEqual({
          kind: "complete_all",
          phase: "completed",
          title: "Complete all",
          messageKey: "pending_complete_all_toast_completed",
          messageArgs: { completed: "3" },
        });
      } finally {
        analysisServiceMock.reset();
        capture.restore();
      }
    });

    it("completes exactly the remaining quota and skips the overflow as quota_exhausted", async () => {
      __resetQuotaStore();
      for (let i = 0; i < ANALYSIS_START_DAILY_MAX - 2; i++) {
        consumeQuota(ANALYSIS_START_QUOTA, ANALYSIS_START_DAILY_MAX, batchUser.id);
      }
      const capture = captureSyncEvents();
      const calledWith: number[] = [];
      analysisServiceMock.autoCompleteAnalysis = async (...args: unknown[]) => {
        calledWith.push(args[2] as number);
      };
      try {
        expect(await runAll()).toBe(3);
        // Quota ran out after two: the third row never reaches the service.
        expect(calledWith).toEqual([initialIds[0], initialIds[1]]);
        expect(capture.events[1].data).toEqual({
          kind: "complete_all",
          phase: "completed",
          title: "Complete all",
          messageKey: "pending_complete_all_toast_completed_skipped",
          messageArgs: { completed: "2", skipped: "1" },
        });
      } finally {
        analysisServiceMock.reset();
        capture.restore();
        __resetQuotaStore();
      }
    });
  });
});
