// Guards the paired-router mount order (see src/index.ts): each shared prefix
// mounts the plain router BEFORE its strava-middleware twin, so plain routes
// stay reachable for users without a Strava link while strava-only routes 403.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; email: string };
let activityId: number;

beforeAll(async () => {
  // No Strava (or intervals.icu) tokens for this suite, so strava-only routes 403.
  user = await createTestUser({ role: "premium", strava: false, intervals: false });
  const a = await insertActivity(user.id, { title: "Mount Order Run" });
  activityId = a.id;
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  role: "premium" as const,
});

describe("paired-router mount order", () => {
  it("GET /api/v1/activity/:id works without a Strava link", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request(`http://test/api/v1/activity/${activityId}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(activityId);
    }));

  it("strava-only POST /api/v1/activity/:id/editor-state returns 403, not a broken plain route", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/activity/${activityId}/editor-state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trainingType: "EASY" }),
        }),
      );
      expect(res.status).toBe(403);
    }));

  it("GET /api/v1/gear works without a Strava link", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/gear"));
      expect(res.status).toBe(200);
    }));

  it("strava-only POST /api/v1/gear/sync returns 403", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/gear/sync", { method: "POST" }));
      expect(res.status).toBe(403);
    }));
});
