// The REAL intervals.icu webhook ingest. tests/setup.ts mocks this module
// globally (endpoint tests only need the no-op), so the genuine implementation
// is loaded via a query-suffix specifier — a different module registry key that
// bypasses the mock while its own imports (intervals_link_service,
// intervals_api_service, intervals_middleware) still resolve normally.
//
// intervals.icu responses are controlled by monkeypatching the (globally mocked)
// intervalsApiService object, restored after each test (the strava_dedup.test.ts
// pattern) rather than mock.module, which would leak across files.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, users } from "../src/schema";
import { intervalsApiService } from "../src/services/intervals_api_service";
import { progressService, type StreamHandle } from "../src/services/progress_service";
import { deleteProviderToken } from "../src/services/oauth_token_store";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { synthIntervalsActivity } from "./helpers/intervals_fixtures";

const DAY_MS = 24 * 60 * 60 * 1000;

const realModuleSpecifier = "../src/services/process_intervals_event.ts?real=1";
const { processIntervalsWebhook } = (await import(
  realModuleSpecifier
)) as typeof import("../src/services/process_intervals_event");

const db = getDb();
const context = { db } as never;

let athleteSeq = 90_000 + Math.floor(Math.random() * 10_000);

async function createIntervalsUser(opts?: { lastSeenDaysAgo?: number }) {
  const user = await createTestUser({ role: "premium" });
  const athleteId = `i-ath-${++athleteSeq}`;
  const lastSeenAt =
    opts?.lastSeenDaysAgo != null ? new Date(Date.now() - opts.lastSeenDaysAgo * DAY_MS) : null;
  await db
    .update(users)
    .set({ intervalsAthleteId: athleteId, lastSeenAt })
    .where(eq(users.id, user.id));
  return { ...user, athleteId };
}

const activitiesFor = (userId: string) =>
  db.select().from(activities).where(eq(activities.userId, userId));

function activityEvent(
  type: string,
  athleteId: string,
  intervalsActivityId: string,
): Parameters<typeof processIntervalsWebhook>[0] {
  return {
    type,
    athlete_id: athleteId,
    activity: { id: intervalsActivityId },
  } as never;
}

// Monkeypatch the (mocked) intervalsApiService object; restore after each test.
const realGetActivity = intervalsApiService.getActivity;
let getActivityResult: unknown = null;

beforeEach(() => {
  intervalsApiService.getActivity = (async () =>
    getActivityResult) as typeof intervalsApiService.getActivity;
});

afterEach(() => {
  intervalsApiService.getActivity = realGetActivity;
  getActivityResult = null;
});

afterAll(async () => {
  await closePool();
});

describe("processIntervalsWebhook (real implementation)", () => {
  it("creates a pending intervals-sourced row on UPLOADED when nothing matches, idempotently", async () => {
    const user = await createIntervalsUser();
    try {
      const act = synthIntervalsActivity({ distance: 7000 });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(act.id);
      expect(rows[0].stravaActivityId).toBeNull();
      expect(rows[0].analysisStatus).toBe("pending");

      // Webhooks retry — a redelivery of the same event must not duplicate.
      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );
      expect(await activitiesFor(user.id)).toHaveLength(1);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("treats ACTIVITY_CREATED as an alias of UPLOADED", async () => {
    const user = await createIntervalsUser();
    try {
      const act = synthIntervalsActivity({ distance: 5500 });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_CREATED", user.athleteId, act.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(act.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("links an existing unlinked local row by fuzzy time/distance instead of creating", async () => {
    const user = await createIntervalsUser();
    try {
      const local = await insertActivity(user.id, {
        title: "Local Run",
        startDateLocal: new Date("2026-05-01T08:00:00Z"),
        distance: 6000,
        analysisStatus: "completed",
      });
      // same start (±5 min) and distance (±3 %) → fuzzy match
      const act = synthIntervalsActivity({
        start_date_local: "2026-05-01T08:00:30",
        distance: 6050,
        strava_id: null,
      });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1); // linked, not duplicated
      expect(rows[0].id).toBe(local.id);
      expect(rows[0].intervalsIcuId).toBe(act.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("links an existing Strava row by exact strava_id even when fuzzy time/distance miss", async () => {
    const user = await createIntervalsUser();
    try {
      const local = await insertActivity(user.id, {
        stravaActivityId: 555_111,
        distance: 1,
        startDateLocal: new Date("2020-01-01T00:00:00Z"),
      });
      // shares the Strava id but nothing else fuzzy-matchable
      const act = synthIntervalsActivity({ strava_id: 555_111, distance: 99_999 });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1); // linked onto the Strava row, not duplicated
      expect(rows[0].id).toBe(local.id);
      expect(rows[0].intervalsIcuId).toBe(act.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("does not create a row for a non-analyzed sport type (skipped_sport)", async () => {
    const user = await createIntervalsUser();
    try {
      const act = synthIntervalsActivity({ type: "WeightTraining" });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      expect(await activitiesFor(user.id)).toHaveLength(0);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("UPDATED refreshes enrichment but preserves the user-edited title", async () => {
    const user = await createIntervalsUser();
    try {
      const act = synthIntervalsActivity({ icu_ctl: 10, distance: 8000 });
      getActivityResult = act;
      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      // The user renames the activity in-app; the DB row is the authority.
      await db
        .update(activities)
        .set({ title: "My edited title" })
        .where(eq(activities.intervalsIcuId, act.id));

      // intervals.icu edit arrives with a fresh CTL and a generic auto-name.
      getActivityResult = synthIntervalsActivity({
        id: act.id,
        icu_ctl: 99,
        distance: 8000,
        name: "Treadmill Running",
      });
      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPDATED", user.athleteId, act.id),
        context,
      );

      const [row] = await activitiesFor(user.id);
      expect(row.title).toBe("My edited title"); // preserved
      expect(row.icuCtl).toBe(99); // refreshed
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("ANALYZED creates the row when it arrives before any local row exists (safety net)", async () => {
    const user = await createIntervalsUser();
    try {
      const act = synthIntervalsActivity({ distance: 9000 });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_ANALYZED", user.athleteId, act.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(act.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("stores skipped_inactive (no SSE) when the user was last seen ~70 days ago", async () => {
    const user = await createIntervalsUser({ lastSeenDaysAgo: 70 });
    try {
      const act = synthIntervalsActivity({ distance: 6400 });
      getActivityResult = act;

      const frames: { event: string; data: string }[] = [];
      const unregister = progressService.register(user.id, {
        writeSSE: async (m) => {
          frames.push(m);
        },
      });

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );
      unregister();

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].analysisStatus).toBe("skipped_inactive");
      // no "received" card for an inactivity-skipped create
      const ingest = frames
        .filter((f) => f.event === "progress")
        .map((f) => JSON.parse(f.data) as { kind: string })
        .find((d) => d.kind === "intervals_ingest");
      expect(ingest).toBeUndefined();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("drops the activity entirely when the user was last seen >90 days ago", async () => {
    const user = await createIntervalsUser({ lastSeenDaysAgo: 100 });
    try {
      const act = synthIntervalsActivity({ distance: 6400 });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      expect(await activitiesFor(user.id)).toHaveLength(0);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("creates nothing when the user has no usable intervals.icu token", async () => {
    const user = await createIntervalsUser();
    try {
      await deleteProviderToken(db, user.id, "intervals");
      const act = synthIntervalsActivity({ distance: 6400 });
      getActivityResult = act;

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );

      expect(await activitiesFor(user.id)).toHaveLength(0);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("publishes an intervals_ingest 'received' progress event on create", async () => {
    const user = await createIntervalsUser();
    try {
      const act = synthIntervalsActivity({ distance: 4200 });
      getActivityResult = act;

      const frames: { event: string; data: string }[] = [];
      const handle: StreamHandle = {
        writeSSE: async (m) => {
          frames.push(m);
        },
      };
      const unregister = progressService.register(user.id, handle);

      await processIntervalsWebhook(
        activityEvent("ACTIVITY_UPLOADED", user.athleteId, act.id),
        context,
      );
      unregister();

      const ingest = frames
        .filter((f) => f.event === "progress")
        .map((f) => JSON.parse(f.data) as { kind: string; phase: string })
        .find((d) => d.kind === "intervals_ingest");
      expect(ingest).toBeDefined();
      expect(ingest?.phase).toBe("received");
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
