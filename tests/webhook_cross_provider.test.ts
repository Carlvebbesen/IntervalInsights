// One workout arriving from BOTH providers. Every other webhook suite drives a
// single provider (the existing "fuzzy merge" case seeds the intervals row
// directly rather than driving its handler), so cross-source dedup was never
// covered end-to-end — which is how the zero-distance hole shipped.
//
// Both real handlers are loaded via the query-suffix specifier that bypasses the
// global no-op mocks in tests/setup.ts; the provider API objects are
// monkeypatched and restored per test (the strava_dedup.test.ts pattern).

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, users } from "../src/schema";
import { intervalsApiService } from "../src/services/intervals_api_service";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { synthIntervalsActivity } from "./helpers/intervals_fixtures";

const realStrava = "../src/services/process_strava_event.ts?real=1";
const realIntervals = "../src/services/process_intervals_event.ts?real=1";
const { processStravaWebhook } = (await import(
  realStrava
)) as typeof import("../src/services/process_strava_event");
const { processIntervalsWebhook } = (await import(
  realIntervals
)) as typeof import("../src/services/process_intervals_event");

const db = getDb();
const context = { db } as never;

// The observed 2229/2230 pair: one elliptical, two providers, five minutes apart.
const START_LOCAL = "2026-07-21T13:24:31";

let seq = 500_000 + Math.floor(Math.random() * 100_000);
const nextId = () => ++seq;

async function createDualUser() {
  const user = await createTestUser({ role: "premium" });
  const athleteId = nextId();
  const intervalsAthleteId = `i-ath-x${athleteId}`;
  await db
    .update(users)
    .set({ stravaId: String(athleteId), intervalsAthleteId })
    .where(eq(users.id, user.id));
  return { ...user, athleteId, intervalsAthleteId };
}

const activitiesFor = (userId: string) =>
  db.select().from(activities).where(eq(activities.userId, userId));

function stravaEvent(
  objectId: number,
  ownerId: number,
  aspect: "create" | "update" | "delete",
  updates: Record<string, string> = {},
) {
  return {
    object_type: "activity" as const,
    object_id: objectId,
    aspect_type: aspect,
    owner_id: ownerId,
    subscription_id: 999,
    event_time: Math.floor(Date.now() / 1000),
    updates,
  };
}

function intervalsEvent(type: string, athleteId: string, activityId: string) {
  return { type, athlete_id: athleteId, activity: { id: activityId } } as never;
}

function stravaActivity(id: number, athleteId: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    athlete: { id: athleteId },
    name: "Afternoon Elliptical",
    description: "",
    sport_type: "Elliptical",
    type: "Elliptical",
    distance: 0,
    moving_time: 1806,
    total_elevation_gain: 0,
    start_date_local: `${START_LOCAL}Z`,
    has_heartrate: false,
    gear_id: null,
    trainer: true,
    splits_metric: [],
    ...overrides,
  };
}

function intervalsActivity(overrides: Record<string, unknown> = {}) {
  return synthIntervalsActivity({
    name: "Elliptical",
    type: "Elliptical",
    start_date: START_LOCAL,
    start_date_local: START_LOCAL,
    moving_time: 1805,
    elapsed_time: 1805,
    distance: 0,
    total_elevation_gain: 0,
    trainer: false,
    ...overrides,
  });
}

const realStravaGetActivity = stravaApiService.getActivity;
const realIntervalsGetActivity = intervalsApiService.getActivity;
let stravaResult: unknown;
let intervalsResult: unknown;

beforeEach(() => {
  stravaApiService.getActivity = (async () =>
    stravaResult) as typeof stravaApiService.getActivity;
  intervalsApiService.getActivity = (async () =>
    intervalsResult) as typeof intervalsApiService.getActivity;
});

afterEach(() => {
  stravaApiService.getActivity = realStravaGetActivity;
  intervalsApiService.getActivity = realIntervalsGetActivity;
  stravaResult = undefined;
  intervalsResult = undefined;
});

afterAll(async () => {
  await closePool();
});

describe("cross-provider ingest — one workout, both webhooks", () => {
  it("zero-distance elliptical: intervals UPLOADED then Strava create collapses to one row", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity();
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId);

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );
      expect(await activitiesFor(user.id)).toHaveLength(1);

      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(icu.id);
      expect(rows[0].stravaActivityId).toBe(stravaId);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("zero-distance elliptical: Strava create then intervals UPLOADED collapses to one row", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity();
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId);

      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);
      expect(await activitiesFor(user.id)).toHaveLength(1);

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(icu.id);
      expect(rows[0].stravaActivityId).toBe(stravaId);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("distance-bearing run: intervals UPLOADED then Strava create collapses to one row", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity({ type: "Run", distance: 8000, moving_time: 2400 });
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId, {
        sport_type: "Run",
        type: "Run",
        distance: 8010,
        moving_time: 2399,
      });

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );
      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].stravaActivityId).toBe(stravaId);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("distance-bearing run: Strava create then intervals UPLOADED collapses to one row", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity({ type: "Run", distance: 8000, moving_time: 2400 });
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId, {
        sport_type: "Run",
        type: "Run",
        distance: 8010,
        moving_time: 2399,
      });

      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);
      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(icu.id);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("a zero-distance row does not swallow a real-distance activity in the same window", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity();
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId, {
        sport_type: "Run",
        type: "Run",
        distance: 10_000,
        moving_time: 1805,
      });

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );
      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);

      expect(await activitiesFor(user.id)).toHaveLength(2);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("two different zero-distance sports in the same window stay separate", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity();
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId, {
        sport_type: "Rowing",
        type: "Rowing",
      });

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );
      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);

      expect(await activitiesFor(user.id)).toHaveLength(2);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("same zero-distance sport but a very different duration stays separate", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity({ moving_time: 1805 });
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId, { moving_time: 3600 });

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );
      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context);

      expect(await activitiesFor(user.id)).toHaveLength(2);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("redelivery of both providers' events after a merge still yields one row", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity();
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId);

      const uploaded = intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id);
      const created = stravaEvent(stravaId, user.athleteId, "create");

      await processIntervalsWebhook(uploaded, context);
      await processStravaWebhook(created, context);
      await processIntervalsWebhook(uploaded, context);
      await processStravaWebhook(created, context);

      expect(await activitiesFor(user.id)).toHaveLength(1);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("orphan Strava update (no local row yet)", () => {
  it("creates exactly one row instead of silently dropping the activity", async () => {
    const user = await createDualUser();
    try {
      const stravaId = nextId() * 1000;
      stravaResult = stravaActivity(stravaId, user.athleteId, {
        sport_type: "Run",
        type: "Run",
        distance: 8000,
        moving_time: 2400,
        name: "Edited title",
      });

      await processStravaWebhook(
        stravaEvent(stravaId, user.athleteId, "update", { title: "Edited title" }),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].stravaActivityId).toBe(stravaId);
      expect(rows[0].title).toBe("Edited title");
      expect(rows[0].analysisStatus).toBe("pending");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("racing a real create still yields exactly one row", async () => {
    const user = await createDualUser();
    try {
      const stravaId = nextId() * 1000;
      stravaResult = stravaActivity(stravaId, user.athleteId, {
        sport_type: "Run",
        type: "Run",
        distance: 8000,
        moving_time: 2400,
      });

      await Promise.all([
        processStravaWebhook(stravaEvent(stravaId, user.athleteId, "create"), context),
        processStravaWebhook(
          stravaEvent(stravaId, user.athleteId, "update", { title: "Edited title" }),
          context,
        ),
      ]);

      expect(await activitiesFor(user.id)).toHaveLength(1);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("merges into an existing intervals.icu twin rather than inserting", async () => {
    const user = await createDualUser();
    try {
      const icu = intervalsActivity();
      const stravaId = nextId() * 1000;
      intervalsResult = icu;
      stravaResult = stravaActivity(stravaId, user.athleteId);

      await processIntervalsWebhook(
        intervalsEvent("ACTIVITY_UPLOADED", user.intervalsAthleteId, icu.id),
        context,
      );

      await processStravaWebhook(
        stravaEvent(stravaId, user.athleteId, "update", { title: "Afternoon Elliptical" }),
        context,
      );

      const rows = await activitiesFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].intervalsIcuId).toBe(icu.id);
      expect(rows[0].stravaActivityId).toBe(stravaId);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("a delete arriving before its create stays a no-op", async () => {
    const user = await createDualUser();
    try {
      const stravaId = nextId() * 1000;
      stravaResult = stravaActivity(stravaId, user.athleteId);

      await processStravaWebhook(stravaEvent(stravaId, user.athleteId, "delete"), context);

      expect(await activitiesFor(user.id)).toHaveLength(0);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
