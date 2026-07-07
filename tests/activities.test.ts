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
        new Request("http://test/api/v1/activity", {
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
        new Request("http://test/api/v1/activity", {
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
      const res = await app.fetch(new Request(`http://test/api/v1/activity/${activityId}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(activityId);
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBe(1);
    }));

  it("GET /:id with bad id returns 400", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/activity/abc"));
      expect(res.status).toBe(400);
    }));

  it("GET /:id 404s for foreign activity", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/activity/99999999"));
      expect(res.status).toBe(404);
    }));

  it("GET /:id/segments returns intervalSegments array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/activity/${activityId}/segments`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.intervalSegments)).toBe(true);
    }));

  const patchReq = (id: number | string, body: unknown) =>
    new Request(`http://test/api/v1/activity/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("PATCH /:id updates trainingType", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(patchReq(activityId, { trainingType: "TEMPO" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.trainingType).toBe("TEMPO");
    }));

  it("PATCH /:id updates notes", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(patchReq(activityId, { notes: "felt easy" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notes).toBe("felt easy");
    }));

  it("PATCH /:id updates feeling", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(patchReq(activityId, { feeling: 4 }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.feeling).toBe(4);
    }));

  it("PATCH /:id with no fields returns 400", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(patchReq(activityId, {}));
      expect(res.status).toBe(400);
    }));

  it("PATCH /:id rejects an invalid trainingType", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(patchReq(activityId, { trainingType: "BOGUS" }));
      expect(res.status).toBe(400);
    }));

  it("PATCH /:id on a foreign activity returns 404", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(patchReq(99999999, { notes: "x" }));
      expect(res.status).toBe(404);
    }));
});

describe("/api/activity (Strava-backed)", () => {
  it("GET /:id/laps returns laps array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/activity/${activityId}/laps`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.laps)).toBe(true);
    }));

  it("GET /:id/splits returns splits_metric array", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/activity/${activityId}/splits`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.splits_metric)).toBe(true);
    }));
});
