import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";

// Controllable Strava API for the real runHrBackfill (only its HTTP dependency
// is swapped, per file, delegating to mutable state). `listGate`, when set, lets
// a test pin the job mid-Phase-A2 so it keeps holding its per-user lock.
type SummaryPage = {
  data: Array<Record<string, unknown>>;
  rateLimit: {
    shortTermUsage: number;
    shortTermLimit: number;
    dailyUsage: number;
    dailyLimit: number;
  } | null;
};

const mockState: {
  summaryPages: SummaryPage[];
  listCallCount: number;
  listGate: Promise<void> | null;
  streams: unknown;
} = { summaryPages: [], listCallCount: 0, listGate: null, streams: null };

let releaseGate: (() => void) | null = null;

mock.module("../src/services/strava_api_service.ts", () => ({
  stravaApiService: {
    getActivity: async () => ({ id: 1, splits_metric: [] }),
    getGear: async (_t: string, id: string) => ({
      id,
      name: `Mock Gear ${id}`,
      distance: 0,
      retired: false,
    }),
    getActivityStreams: async () => mockState.streams ?? {},
    getActivityLaps: async () => [],
    listAthleteActivities: async () => [],
    listAthleteActivitiesWithMeta: async (_t: string, query: { page?: string }) => {
      mockState.listCallCount++;
      if (mockState.listGate) await mockState.listGate;
      const idx = Number(query.page ?? "1") - 1;
      return mockState.summaryPages[idx] ?? { data: [], rateLimit: null };
    },
    syncStravaActivities: async (_t: string, _u: string, ids: number[]) =>
      ids.map((id) => ({ id, status: "success" as const })),
  },
}));

import { activities } from "../src/schema";
import { isHrBackfillRunning } from "../src/services/hr_backfill_service";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

const createdUsers: string[] = [];

async function newUser(opts?: Parameters<typeof createTestUser>[0]) {
  const u = await createTestUser(opts);
  createdUsers.push(u.id);
  return u;
}

const identity = (u: { id: string; email: string }) => ({
  userId: u.id,
  role: "premium" as const,
});

async function setStats(
  activityId: number,
  fields: Partial<typeof activities.$inferInsert>,
): Promise<void> {
  await getDb().update(activities).set(fields).where(eq(activities.id, activityId));
}

function backfill() {
  return app.fetch(
    new Request("http://test/api/v1/heart-rate/backfill", { method: "POST" }),
  );
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met within timeout");
}

afterEach(async () => {
  releaseGate?.();
  releaseGate = null;
  // Let any in-flight background job release its per-user lock before cleanup.
  for (const id of createdUsers) {
    await waitFor(() => !isHrBackfillRunning(id), 3000).catch(() => {});
  }
  for (const id of createdUsers) await deleteTestUser(id);
  createdUsers.length = 0;
  mockState.summaryPages = [];
  mockState.listCallCount = 0;
  mockState.listGate = null;
  mockState.streams = null;
});

afterAll(async () => {
  await closePool();
});

describe("POST /api/v1/heart-rate/backfill", () => {
  it("returns 403 and starts no job when the user has not enabled HR processing", async () => {
    const user = await newUser({ processHeartRate: false });
    await withIdentity(identity(user), async () => {
      const res = await backfill();
      expect(res.status).toBe(403);
    });
    expect(isHrBackfillRunning(user.id)).toBe(false);
    expect(mockState.listCallCount).toBe(0);
  });

  it("returns 202 then backfills Strava summary HR and computes stream stats", async () => {
    const user = await newUser({ processHeartRate: true, intervals: false });
    const act = await insertActivity(user.id, { title: "Consent-off import" });
    await setStats(act.id, {
      hasHeartrate: false,
      averageHeartRate: null,
      maxHeartRate: null,
      hrStatsComputedAt: null,
    });

    mockState.summaryPages = [
      {
        data: [
          {
            id: act.stravaActivityId,
            has_heartrate: true,
            average_heartrate: 150,
            max_heartrate: 175,
          },
        ],
        rateLimit: { shortTermUsage: 1, shortTermLimit: 100, dailyUsage: 1, dailyLimit: 1000 },
      },
    ];
    mockState.streams = {
      heartrate: { data: [148, 150, 152] },
      time: { data: [0, 1, 2] },
    };

    await withIdentity(identity(user), async () => {
      const res = await backfill();
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "started" });
    });

    await waitFor(async () => {
      const [row] = await getDb()
        .select({ computedAt: activities.hrStatsComputedAt })
        .from(activities)
        .where(eq(activities.id, act.id));
      return row?.computedAt != null;
    });

    const [row] = await getDb()
      .select({
        avg: activities.averageHeartRate,
        hasHeartrate: activities.hasHeartrate,
        computedAt: activities.hrStatsComputedAt,
      })
      .from(activities)
      .where(eq(activities.id, act.id));
    expect(row.avg).toBe(150);
    expect(row.hasHeartrate).toBe(true);
    expect(row.computedAt).not.toBeNull();
  });

  it("returns 409 when a backfill is already running for the user", async () => {
    const user = await newUser({ processHeartRate: true });
    // Pin Phase A2's first list call so the first job keeps holding the lock.
    mockState.listGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    await withIdentity(identity(user), async () => {
      const first = await backfill();
      expect(first.status).toBe(202);

      await waitFor(() => isHrBackfillRunning(user.id));

      const second = await backfill();
      expect(second.status).toBe(409);
    });
  });

  it("repairs the hasHeartrate flag with zero Strava calls when no Strava token", async () => {
    const user = await newUser({ processHeartRate: true, strava: false, intervals: false });
    const act = await insertActivity(user.id, { title: "Intervals-sourced" });
    await setStats(act.id, {
      stravaActivityId: null,
      intervalsIcuId: "icu-hr-1",
      hasHeartrate: false,
      averageHeartRate: 140,
      maxHeartRate: null,
      hrStatsComputedAt: null,
    });

    await withIdentity(identity(user), async () => {
      const res = await backfill();
      expect(res.status).toBe(202);
    });

    await waitFor(async () => {
      const [row] = await getDb()
        .select({ computedAt: activities.hrStatsComputedAt })
        .from(activities)
        .where(eq(activities.id, act.id));
      return row?.computedAt != null;
    });

    const [row] = await getDb()
      .select({ hasHeartrate: activities.hasHeartrate })
      .from(activities)
      .where(eq(activities.id, act.id));
    expect(row.hasHeartrate).toBe(true);
    expect(mockState.listCallCount).toBe(0);
  });
});
