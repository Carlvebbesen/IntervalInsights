// The REAL Strava webhook ingest. tests/setup.ts mocks this module globally
// (endpoint tests only need the no-op), so the genuine implementation is
// loaded via a query-suffix specifier — a DIFFERENT module registry key that
// bypasses the mock while its own imports (strava_api_service, clerk_client,
// analysis_service) still resolve to the global mocks.
//
// Strava responses are controlled by monkeypatching the mocked
// stravaApiService OBJECT (the strava_dedup.test.ts pattern) instead of
// mock.module, which would leak across files.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import * as gearRepo from "../src/repositories/gear_repository";
import { activities, gears } from "../src/schema";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

const realModuleSpecifier = "../src/services/process_strava_event.ts?real=1";
const { processStravaWebhook } = (await import(
  realModuleSpecifier
)) as typeof import("../src/services/process_strava_event");

const db = getDb();
const context = { db };

const DAY_MS = 24 * 60 * 60 * 1000;

let stravaIdSeq = 700_000 + Math.floor(Math.random() * 100_000);
const nextAthleteId = () => ++stravaIdSeq;

function stravaActivity(id: number, athleteId: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    athlete: { id: athleteId },
    name: "Webhook Run",
    description: "",
    sport_type: "Run",
    type: "Run",
    distance: 8000,
    moving_time: 2400,
    total_elevation_gain: 40,
    start_date_local: "2026-07-01T10:00:00Z",
    has_heartrate: false,
    gear_id: null,
    trainer: false,
    splits_metric: [],
    ...overrides,
  };
}

function createEvent(objectId: number, ownerId: number, aspect: "create" | "update" | "delete") {
  return {
    object_type: "activity" as const,
    object_id: objectId,
    aspect_type: aspect,
    owner_id: ownerId,
    subscription_id: 999,
    event_time: Math.floor(Date.now() / 1000),
    updates: {},
  };
}

async function createStravaUser(opts?: { lastSeenDaysAgo?: number }) {
  const user = await createTestUser({ role: "premium" });
  const athleteId = nextAthleteId();
  const lastSeenAt =
    opts?.lastSeenDaysAgo != null ? new Date(Date.now() - opts.lastSeenDaysAgo * DAY_MS) : null;
  const { users } = await import("../src/schema");
  await db
    .update(users)
    .set({ stravaId: String(athleteId), lastSeenAt })
    .where(eq(users.id, user.id));
  return { ...user, athleteId };
}

const activitiesFor = (userId: string) =>
  db.select().from(activities).where(eq(activities.userId, userId));

// Monkeypatch the (mocked) stravaApiService object; restore after each test.
const realGetActivity = stravaApiService.getActivity;
let getActivityResult: unknown;

beforeEach(() => {
  stravaApiService.getActivity = (async () =>
    getActivityResult) as typeof stravaApiService.getActivity;
});

afterEach(() => {
  stravaApiService.getActivity = realGetActivity;
});

afterAll(async () => {
  await closePool();
});

describe("processStravaWebhook (real implementation)", () => {
  it("inserts a pending activity on create, and a duplicate create is idempotent", async () => {
    const user = await createStravaUser();
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId);

      await processStravaWebhook(
        createEvent(stravaActivityId, user.athleteId, "create"),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].stravaActivityId).toBe(stravaActivityId);
      expect(rows[0].analysisStatus).toBe("pending");

      // Strava retries webhooks — a second identical create must not duplicate.
      await processStravaWebhook(
        createEvent(stravaActivityId, user.athleteId, "create"),
        context,
      );
      expect(await activitiesFor(user.id)).toHaveLength(1);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("stores the activity as skipped_inactive when the user was last seen ~70 days ago", async () => {
    const user = await createStravaUser({ lastSeenDaysAgo: 70 });
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId);

      await processStravaWebhook(
        createEvent(stravaActivityId, user.athleteId, "create"),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].analysisStatus).toBe("skipped_inactive");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("drops the activity entirely when the user was last seen >90 days ago", async () => {
    const user = await createStravaUser({ lastSeenDaysAgo: 100 });
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId);

      await processStravaWebhook(
        createEvent(stravaActivityId, user.athleteId, "create"),
        context,
      );

      expect(await activitiesFor(user.id)).toHaveLength(0);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("scopes deletes to the event owner: B's delete for A's activity id is a no-op", async () => {
    // strava_activity_id is globally unique, so B cannot own a row with A's id;
    // the guard under test is that B's forged/mis-routed delete must not touch
    // A's row.
    const userA = await createStravaUser();
    const userB = await createStravaUser();
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      await insertActivity(userA.id, { stravaActivityId });

      await processStravaWebhook(
        createEvent(stravaActivityId, userB.athleteId, "delete"),
        context,
      );
      expect(await activitiesFor(userA.id)).toHaveLength(1);

      // Positive control: the owner's delete removes the row.
      await processStravaWebhook(
        createEvent(stravaActivityId, userA.athleteId, "delete"),
        context,
      );
      expect(await activitiesFor(userA.id)).toHaveLength(0);
    } finally {
      await deleteTestUser(userA.id);
      await deleteTestUser(userB.id);
    }
  });

  it("ignores an update whose fetched activity belongs to a different athlete (owner mismatch)", async () => {
    const user = await createStravaUser();
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      await insertActivity(user.id, { stravaActivityId, title: "Original title" });

      // Strava returns an activity owned by someone else than the event claims.
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId + 1, {
        name: "Forged title",
      });

      await processStravaWebhook(
        createEvent(stravaActivityId, user.athleteId, "update"),
        context,
      );

      const [row] = await activitiesFor(user.id);
      expect(row.title).toBe("Original title");

      // Positive control: a matching owner does apply the update.
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId, {
        name: "Renamed run",
      });
      await processStravaWebhook(
        createEvent(stravaActivityId, user.athleteId, "update"),
        context,
      );
      const [updated] = await activitiesFor(user.id);
      expect(updated.title).toBe("Renamed run");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  const insertGear = async (userId: string, model: string, stravaGearId: string) => {
    const [row] = await db
      .insert(gears)
      .values({ userId, model, surface: "ROAD", stravaGearId })
      .returning();
    return row;
  };

  const gearById = async (id: number) => {
    const [row] = await db.select().from(gears).where(eq(gears.id, id));
    return row;
  };

  it("re-links gear on an update whose gear_id changed, keeping both gears' counters", async () => {
    const user = await createStravaUser();
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      const gearA = await insertGear(user.id, "Old Shoe", "g-old");
      const gearB = await insertGear(user.id, "New Shoe", "g-new");
      const seeded = await insertActivity(user.id, {
        stravaActivityId,
        distance: 5000,
        gearId: "g-old",
      });
      await gearRepo.assignActivityToGear(db, user.id, seeded.id, gearA.id);

      getActivityResult = stravaActivity(stravaActivityId, user.athleteId, {
        gear_id: "g-new",
        distance: 5000,
      });
      await processStravaWebhook(createEvent(stravaActivityId, user.athleteId, "update"), context);

      const [row] = await activitiesFor(user.id);
      expect(row.localGearId).toBe(gearB.id);
      expect(row.gearUpdatedFromStrava).toBe(true);
      expect(row.gearId).toBe("g-new");

      const oldGear = await gearById(gearA.id);
      expect(oldGear.activityCount).toBe(0);
      expect(oldGear.maintainedDistanceMeters).toBe(0);
      const newGear = await gearById(gearB.id);
      expect(newGear.activityCount).toBe(1);
      expect(newGear.maintainedDistanceMeters).toBe(5000);
      // Attributes refreshed from the (mocked) getGear response.
      expect(newGear.model).toBe("Mock Gear g-new");

      // A gear_id change to null clears the link and decrements the counters.
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId, {
        gear_id: null,
        distance: 5000,
      });
      await processStravaWebhook(createEvent(stravaActivityId, user.athleteId, "update"), context);

      const [cleared] = await activitiesFor(user.id);
      expect(cleared.localGearId).toBeNull();
      expect(cleared.gearUpdatedFromStrava).toBe(true);
      const newGearAfter = await gearById(gearB.id);
      expect(newGearAfter.activityCount).toBe(0);
      expect(newGearAfter.maintainedDistanceMeters).toBe(0);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("lazy-imports an unknown gear on update and does not flag when gear_id is unchanged", async () => {
    const user = await createStravaUser();
    try {
      const stravaActivityId = nextAthleteId() * 1000;
      const seeded = await insertActivity(user.id, { stravaActivityId, distance: 5000 });

      // Unchanged gear_id (null → null): no re-link, no flag.
      getActivityResult = stravaActivity(stravaActivityId, user.athleteId, { distance: 5000 });
      await processStravaWebhook(createEvent(stravaActivityId, user.athleteId, "update"), context);
      let [row] = await activitiesFor(user.id);
      expect(row.gearUpdatedFromStrava).toBe(false);

      getActivityResult = stravaActivity(stravaActivityId, user.athleteId, {
        gear_id: "g-fresh",
        distance: 5000,
      });
      await processStravaWebhook(createEvent(stravaActivityId, user.athleteId, "update"), context);

      [row] = await activitiesFor(user.id);
      expect(row.gearUpdatedFromStrava).toBe(true);
      expect(row.localGearId).not.toBeNull();
      const imported = await gearById(row.localGearId as number);
      expect(imported.stravaGearId).toBe("g-fresh");
      expect(imported.activityCount).toBe(1);
      expect(seeded.id).toBe(row.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
