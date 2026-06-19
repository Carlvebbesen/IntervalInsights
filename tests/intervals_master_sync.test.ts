import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import type { IIntervalsActivity } from "../src/types/intervals/IIntervalsActivity";

// Controllable intervals.icu API for the real syncAllFromIntervals (its module
// is NOT mocked globally — only its HTTP dependency is, here, per file).
const mockState: {
  windows: IIntervalsActivity[][];
  cursor: number;
  byId: Record<string, IIntervalsActivity>;
} = { windows: [], cursor: 0, byId: {} };

mock.module("../src/services/intervals_api_service.ts", () => ({
  DEFAULT_INTERVALS_STREAM_TYPES: [],
  intervalsApiService: {
    listActivities: async () => mockState.windows[mockState.cursor++] ?? [],
    getActivity: async (_t: string, id: string) => mockState.byId[id] ?? null,
    getActivityStreams: async () => [],
    getActivityIntervals: async () => ({ icu_intervals: [] }),
    getAthlete: async () => ({ id: "i12345" }),
    getWellness: async () => [],
  },
}));

import { activities } from "../src/schema";
import { syncAllFromIntervals } from "../src/services/intervals_link_service";
import { progressService, type StreamHandle } from "../src/services/progress_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { synthIntervalsActivity } from "./helpers/intervals_fixtures";

let user: { id: string; clerkId: string };

beforeEach(async () => {
  user = await createTestUser({ role: "premium" });
  mockState.windows = [];
  mockState.cursor = 0;
  mockState.byId = {};
});

afterEach(async () => {
  await deleteTestUser(user.id);
});

afterAll(async () => {
  await closePool();
});

function loadWindow(...acts: IIntervalsActivity[]) {
  mockState.windows = [acts];
  mockState.cursor = 0;
  mockState.byId = Object.fromEntries(acts.map((a) => [a.id, a]));
}

describe("syncAllFromIntervals (master sync)", () => {
  it("creates a null-Strava 'completed' row for an intervals-only activity (no LLM)", async () => {
    const a = synthIntervalsActivity({ distance: 7000 });
    loadWindow(a);

    const result = await syncAllFromIntervals({ db: getDb() }, user);

    expect(result.created).toBe(1);
    expect(result.linked).toBe(0);
    expect(result.processed).toBe(1);

    const rows = await getDb().select().from(activities).where(eq(activities.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].stravaActivityId).toBeNull();
    expect(rows[0].intervalsIcuId).toBe(a.id);
    // cost-safety: bulk-imported history is browsable, never auto-analyzed
    expect(rows[0].analysisStatus).toBe("completed");
    expect(rows[0].title).toBe(a.name ?? "Untitled activity");
  });

  it("imports a no-distance activity (elliptical/strength/swim) as distance 0, not a failure", async () => {
    const a = synthIntervalsActivity({ distance: null, moving_time: null, type: "WeightTraining" });
    loadWindow(a);

    const result = await syncAllFromIntervals({ db: getDb() }, user);

    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const rows = await getDb().select().from(activities).where(eq(activities.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].distance).toBe(0);
    expect(rows[0].movingTime).toBe(0);
    expect(rows[0].stravaActivityId).toBeNull();
    expect(rows[0].analysisStatus).toBe("completed");
  });

  it("links a matching existing local activity instead of creating a duplicate", async () => {
    const local = await insertActivity(user.id, {
      title: "Strava Run",
      startDateLocal: new Date("2026-05-01T08:00:00Z"),
      distance: 6000,
      analysisStatus: "completed",
    });
    // same start (±5min) and distance (±3%) → fuzzy match
    const a = synthIntervalsActivity({
      start_date_local: "2026-05-01T08:00:30",
      distance: 6050,
    });
    loadWindow(a);

    const result = await syncAllFromIntervals({ db: getDb() }, user);

    expect(result.linked).toBe(1);
    expect(result.created).toBe(0);

    const [row] = await getDb().select().from(activities).where(eq(activities.id, local.id));
    expect(row.intervalsIcuId).toBe(a.id);
    expect(row.stravaActivityId).toBe(local.stravaActivityId);

    const all = await getDb().select().from(activities).where(eq(activities.userId, user.id));
    expect(all).toHaveLength(1);
  });

  it("skips activities already linked locally", async () => {
    const a = synthIntervalsActivity();
    await getDb()
      .insert(activities)
      .values({
        userId: user.id,
        stravaActivityId: null,
        intervalsIcuId: a.id,
        title: "Already Linked",
        sportType: "Run",
        distance: a.distance ?? 0,
        movingTime: a.moving_time ?? 0,
        startDateLocal: new Date("2026-05-01T08:00:00Z"),
        analysisStatus: "completed",
        indoor: false,
      });
    loadWindow(a);

    const result = await syncAllFromIntervals({ db: getDb() }, user);

    expect(result.created).toBe(0);
    expect(result.linked).toBe(0);
    expect(result.candidates).toBe(0);
  });

  it("publishes sync progress events (started + completed) to the channel", async () => {
    const a = synthIntervalsActivity();
    loadWindow(a);

    const frames: { event: string; data: string }[] = [];
    const handle: StreamHandle = {
      writeSSE: async (m) => {
        frames.push(m);
      },
    };
    const unregister = progressService.register(user.id, handle);

    await syncAllFromIntervals({ db: getDb() }, user);
    unregister();

    const syncEvents = frames
      .filter((f) => f.event === "sync")
      .map((f) => JSON.parse(f.data) as { phase: string; kind: string; created?: number });

    expect(syncEvents.some((e) => e.phase === "started")).toBe(true);
    const completed = syncEvents.find((e) => e.phase === "completed");
    expect(completed).toBeDefined();
    expect(completed?.kind).toBe("intervals_master_sync");
    expect(completed?.created).toBe(1);
  });
});
