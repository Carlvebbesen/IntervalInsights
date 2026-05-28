import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  closePool,
  createTestUser,
  deleteTestUser,
  getPool,
} from "./helpers/db";
import { insertActivity, insertEvent, linkEventToActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let activityId: number;

beforeAll(async () => {
  user = await createTestUser({ role: "premium", processHeartRate: true });
  const a = await insertActivity(user.id, {
    title: "Morning Run",
    distance: 10_000,
    trainingType: "EASY",
  });
  activityId = a.id;
  // Link an event so /activity/:id returns it as well
  const ev = await insertEvent(user.id, { description: "Knee twinge" });
  await linkEventToActivity(activityId, ev.id);
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

describe("/api/activity", () => {
  it("POST / returns paginated list", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: 1 }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.meta.page).toBe(1);
    }));

  it("POST / supports filters", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page: 1,
            search: "Morning",
            trainingType: ["EASY"],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.every((a: { title: string }) => a.title.includes("Morning"))).toBe(true);
    }));

  it("GET /:id returns activity with linked events", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request(`http://test/api/activity/${activityId}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(activityId);
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBe(1);
    }));

  it("GET /:id with bad id returns 400", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/activity/abc"));
      expect(res.status).toBe(400);
    }));

  it("GET /:id 404s for foreign activity", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/activity/99999999"));
      expect(res.status).toBe(404);
    }));

  it("GET /:id/segments returns intervalSegments array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/activity/${activityId}/segments`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.intervalSegments)).toBe(true);
    }));

  it("POST /update updates trainingType + notes", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/activity/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: activityId,
            trainingType: "TEMPO",
            notes: "felt easy",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.trainingType).toBe("TEMPO");
      expect(body.notes).toBe("felt easy");
    }));

  it("POST /update with no fields returns 400", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/activity/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: activityId }),
        }),
      );
      expect(res.status).toBe(400);
    }));

  it("POST /update on foreign activity returns 404", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/activity/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: 99999999, notes: "x" }),
        }),
      );
      expect(res.status).toBe(404);
    }));
});

describe("/api/activity (Strava-backed)", () => {
  it("GET /gear/stats returns stats array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/activity/gear/stats"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.stats)).toBe(true);
    }));

  it("GET /:id/laps returns laps array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/activity/${activityId}/laps`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.laps)).toBe(true);
    }));

  it("GET /:id/splits returns splits_metric array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/activity/${activityId}/splits`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.splits_metric)).toBe(true);
    }));

  it("GET /:id/heartrate returns 403 without consent", async () => {
    const noConsentUser = await createTestUser({ processHeartRate: false });
    const seeded = await insertActivity(noConsentUser.id);
    try {
      const res = await withIdentity(
        {
          userId: noConsentUser.id,
          clerkUserId: noConsentUser.clerkId,
          role: "premium",
        },
        () =>
          app.fetch(
            new Request(`http://test/api/activity/${seeded.id}/heartrate`),
          ),
      );
      expect(res.status).toBe(403);
    } finally {
      await deleteTestUser(noConsentUser.id);
    }
  });

  it("GET /:id/heartrate returns 200 with consent", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/activity/${activityId}/heartrate`),
      );
      expect(res.status).toBe(200);
    }));
});
