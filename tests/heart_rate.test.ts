import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, intervalStructures } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { clerkUsersMock } from "./setup";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let noConsentUser: { id: string; clerkId: string };
let structureId: number;
let intervalActivityId: number;
let oldActivityId: number;

const RECENT = new Date("2026-05-20T06:00:00.000Z");
const OLD = new Date("2024-01-10T06:00:00.000Z");

async function setStats(
  activityId: number,
  fields: Partial<typeof activities.$inferInsert>,
): Promise<void> {
  await getDb().update(activities).set(fields).where(eq(activities.id, activityId));
}

beforeAll(async () => {
  user = await createTestUser({ role: "premium", processHeartRate: true });
  noConsentUser = await createTestUser({ role: "premium", processHeartRate: false });

  // An interval structure + signature to filter on.
  const [structure] = await getDb()
    .insert(intervalStructures)
    .values({ name: "4x4 VO2max", signature: "sig-4x4" })
    .returning();
  structureId = structure.id;

  // A1 — whole-activity stats only.
  const a1 = await insertActivity(user.id, {
    title: "Long run",
    trainingType: "LONG",
    startDateLocal: RECENT,
  });
  await setStats(a1.id, {
    hasHeartrate: true,
    averageHeartRate: 145,
    maxHeartRate: 178,
    medianHeartRate: 148,
    modeHeartRate: 150,
    hrStatsComputedAt: new Date(),
  });

  // A2 — interval activity with work-interval stats, linked to the signature.
  const a2 = await insertActivity(user.id, {
    title: "4x4 VO2max",
    trainingType: "SHORT_INTERVALS",
    startDateLocal: RECENT,
  });
  intervalActivityId = a2.id;
  await setStats(a2.id, {
    intervalStructureId: structureId,
    hasHeartrate: true,
    averageHeartRate: 162,
    maxHeartRate: 188,
    medianHeartRate: 165,
    modeHeartRate: 170,
    workAvgHeartRate: 168,
    workMaxHeartRate: 190,
    workMedianHeartRate: 172,
    workModeHeartRate: 175,
    hrStatsComputedAt: new Date(),
  });

  // A3 — old activity, for the date filter.
  const a3 = await insertActivity(user.id, {
    title: "Old easy run",
    trainingType: "EASY",
    startDateLocal: OLD,
  });
  oldActivityId = a3.id;
  await setStats(a3.id, {
    hasHeartrate: true,
    averageHeartRate: 130,
    maxHeartRate: 150,
    medianHeartRate: 131,
    modeHeartRate: 128,
    hrStatsComputedAt: new Date(),
  });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(noConsentUser.id);
  await getDb().delete(intervalStructures).where(eq(intervalStructures.id, structureId));
  await closePool();
});

const identity = (u: { id: string; clerkId: string }) => ({
  userId: u.id,
  clerkUserId: u.clerkId,
  role: "premium" as const,
});

function analyze(body: Record<string, unknown>) {
  return app.fetch(
    new Request("http://test/api/v1/heart-rate/analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/heart-rate/analysis", () => {
  it("returns 403 when the user has not enabled heart-rate processing", () =>
    withIdentity(identity(noConsentUser), async () => {
      const res = await analyze({});
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Heart-rate");
    }));

  it("returns status:ok with points, zones and summaries", () =>
    withIdentity(identity(user), async () => {
      const res = await analyze({});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(Array.isArray(body.points)).toBe(true);
      expect(Array.isArray(body.zones)).toBe(true);
      expect(body.points.length).toBeGreaterThanOrEqual(3);

      const a1 = body.points.find((p: { activityId: number }) => p.activityId === intervalActivityId);
      expect(a1).toMatchObject({ avgHr: 162, maxHr: 188, medianHr: 165, modeHr: 170, name: "4x4 VO2max" });

      // summaries keyed by metric api-key; min/max reference returned points.
      const ids = new Set(body.points.map((p: { activityId: number }) => p.activityId));
      for (const key of ["avgHr", "maxHr", "medianHr", "modeHr"]) {
        expect(body.summaries[key]).toBeDefined();
        expect(typeof body.summaries[key].mean).toBe("number");
        expect(ids.has(body.summaries[key].min.activityId)).toBe(true);
        expect(ids.has(body.summaries[key].max.activityId)).toBe(true);
      }
    }));

  it("intervalsOnly returns work-interval metrics", () =>
    withIdentity(identity(user), async () => {
      const res = await analyze({ signatures: ["sig-4x4"], intervalsOnly: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.points).toHaveLength(1);
      expect(body.points[0]).toMatchObject({
        activityId: intervalActivityId,
        avgHr: 168,
        maxHr: 190,
        medianHr: 172,
        modeHr: 175,
      });
    }));

  it("filters by trainingType", () =>
    withIdentity(identity(user), async () => {
      const res = await analyze({ trainingType: ["SHORT_INTERVALS"] });
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.points).toHaveLength(1);
      expect(body.points[0].activityId).toBe(intervalActivityId);
    }));

  it("filters by signature", () =>
    withIdentity(identity(user), async () => {
      const res = await analyze({ signatures: ["sig-4x4"] });
      const body = await res.json();
      expect(body.points).toHaveLength(1);
      expect(body.points[0].activityId).toBe(intervalActivityId);
    }));

  it("filters by date range (excludes the old activity)", () =>
    withIdentity(identity(user), async () => {
      const res = await analyze({ dateFrom: "2026-01-01T00:00:00.000Z" });
      const body = await res.json();
      const ids = body.points.map((p: { activityId: number }) => p.activityId);
      expect(ids).not.toContain(oldActivityId);
      expect(ids).toContain(intervalActivityId);
    }));

  it("returns status:no_data when nothing matches the filter", () =>
    withIdentity(identity(user), async () => {
      const res = await analyze({
        dateFrom: "2099-01-01T00:00:00.000Z",
        dateTo: "2099-12-31T00:00:00.000Z",
      });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("no_data");
    }));

  it("lazily marks HR stats as computed for an activity that lacks them", () =>
    withIdentity(identity(user), async () => {
      // A fresh activity with HR but no computed stats, isolated by trainingType.
      const lazy = await insertActivity(user.id, {
        title: "Race",
        trainingType: "RACE",
        startDateLocal: RECENT,
      });
      await setStats(lazy.id, { hasHeartrate: true, hrStatsComputedAt: null });

      const res = await analyze({ trainingType: ["RACE"] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.points).toHaveLength(1);

      // The lazy path ran (Strava streams mocked empty → null metrics) and
      // persisted the attempt so we don't refetch next time.
      const [updated] = await getDb()
        .select({ computedAt: activities.hrStatsComputedAt })
        .from(activities)
        .where(eq(activities.id, lazy.id));
      expect(updated.computedAt).not.toBeNull();
    }));

  describe("intervals.icu stream source + avg/max backfill", () => {
    beforeAll(() => {
      mock.module("../src/services/intervals_api_service.ts", () => ({
        DEFAULT_INTERVALS_STREAM_TYPES: [],
        intervalsApiService: {
          getAthlete: async () => ({ id: "i12345" }),
          getWellness: async () => [],
          getActivity: async () => null,
          listActivities: async () => [],
          getActivityStreams: async () => [
            { type: "time", data: [0, 1, 2] },
            { type: "heartrate", data: [150, 150, 160] },
          ],
        },
      }));
    });

    afterAll(() => {
      mock.module("../src/services/intervals_api_service.ts", () => ({
        DEFAULT_INTERVALS_STREAM_TYPES: [],
        intervalsApiService: {
          getAthlete: async () => ({ id: "i12345" }),
          getWellness: async () => [],
          getActivity: async () => null,
          listActivities: async () => [],
        },
      }));
    });

    it("computes stats from intervals.icu streams and backfills null avg/max", () =>
      withIdentity(identity(user), async () => {
        const act = await insertActivity(user.id, {
          title: "ICU-sourced",
          trainingType: "OTHER",
          startDateLocal: RECENT,
        });
        await setStats(act.id, {
          intervalsIcuId: "icu-123",
          hasHeartrate: true,
          averageHeartRate: null,
          maxHeartRate: null,
          hrStatsComputedAt: null,
        });

        const res = await analyze({ trainingType: ["OTHER"] });
        const body = await res.json();
        expect(body.status).toBe("ok");
        expect(body.points).toHaveLength(1);
        // median/mode prove the intervals.icu stream was used (the Strava mock
        // returns no HR); avg/max are backfilled from the histogram.
        expect(body.points[0]).toMatchObject({
          activityId: act.id,
          avgHr: 153,
          maxHr: 160,
          medianHr: 150,
          modeHr: 150,
        });

        const [row] = await getDb()
          .select({
            avg: activities.averageHeartRate,
            max: activities.maxHeartRate,
            computedAt: activities.hrStatsComputedAt,
          })
          .from(activities)
          .where(eq(activities.id, act.id));
        expect(row.avg).toBe(153);
        expect(row.max).toBe(160);
        expect(row.computedAt).not.toBeNull();
      }));
  });

  describe("when intervals.icu is not linked", () => {
    beforeAll(() => {
      clerkUsersMock.getUser = async () => ({
        privateMetadata: { strava: {} },
        publicMetadata: {},
      });
    });

    afterAll(() => {
      clerkUsersMock.reset();
    });

    it("returns status:not_linked", () =>
      withIdentity(identity(user), async () => {
        const res = await analyze({});
        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe("not_linked");
      }));
  });
});
