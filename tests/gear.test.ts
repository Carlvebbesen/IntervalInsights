// Gear endpoints: create / list / update (retire) / assign-to-activity.
// Pure-db routes — no Strava sync coverage here (gearStravaRouter needs live
// Strava responses; the mocked service returns nothing useful).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let otherUser: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  otherUser = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(otherUser.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

const jsonReq = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function createGear(body: Record<string, unknown>) {
  const res = await app.fetch(jsonReq("http://test/api/v1/gear", "POST", body));
  expect(res.status).toBe(201);
  return res.json();
}

describe("/api/v1/gear", () => {
  it("creates a shoe with default buckets and lists it", () =>
    withIdentity(identity(), async () => {
      const created = await createGear({
        brand: "Nike",
        model: "Pegasus 41",
        surface: "ROAD",
        defaultEasy: true,
      });
      expect(created).toMatchObject({
        brand: "Nike",
        model: "Pegasus 41",
        surface: "ROAD",
        isActive: true,
        isDefaultEasy: true,
        isDefaultLong: false,
        activityCount: 0,
        distanceMeters: 0,
      });
      expect(created.displayName).toBe("Nike Pegasus 41");

      const listRes = await app.fetch(new Request("http://test/api/v1/gear"));
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      expect(list.data.some((g: { id: number }) => g.id === created.id)).toBe(true);
    }));

  it("sets and clears the RACE default like the other buckets", () =>
    withIdentity(identity(), async () => {
      const created = await createGear({
        model: "Vaporfly",
        surface: "ROAD",
        defaultRace: true,
      });
      expect(created.isDefaultRace).toBe(true);
      expect(created.isDefaultEasy).toBe(false);

      const clearRes = await app.fetch(
        jsonReq(`http://test/api/v1/gear/${created.id}`, "PATCH", { defaultRace: false }),
      );
      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.isDefaultRace).toBe(false);
    }));

  it("round-trips useTypes through create, patch, and list", () =>
    withIdentity(identity(), async () => {
      const created = await createGear({
        model: "Takumi Sen",
        surface: "ROAD",
        useTypes: ["SHORT_INTERVALS", "LONG_INTERVALS"],
      });
      expect(created.useTypes).toEqual(["SHORT_INTERVALS", "LONG_INTERVALS"]);

      const list = await (await app.fetch(new Request("http://test/api/v1/gear"))).json();
      const listed = list.data.find((g: { id: number }) => g.id === created.id);
      expect(listed.useTypes).toEqual(["SHORT_INTERVALS", "LONG_INTERVALS"]);

      const patchRes = await app.fetch(
        jsonReq(`http://test/api/v1/gear/${created.id}`, "PATCH", { useTypes: ["TEMPO"] }),
      );
      expect(patchRes.status).toBe(200);
      expect((await patchRes.json()).useTypes).toEqual(["TEMPO"]);

      const badRes = await app.fetch(
        jsonReq(`http://test/api/v1/gear/${created.id}`, "PATCH", { useTypes: ["NOT_A_TYPE"] }),
      );
      expect(badRes.status).toBe(400);
    }));

  it("rejects a create without a model", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq("http://test/api/v1/gear", "POST", { surface: "ROAD" }),
      );
      expect(res.status).toBe(400);
    }));

  it("updates nickname and retires a shoe (isActive=false hides it from the default list)", () =>
    withIdentity(identity(), async () => {
      const created = await createGear({ model: "Kinvara", surface: "ROAD" });

      const patchRes = await app.fetch(
        jsonReq(`http://test/api/v1/gear/${created.id}`, "PATCH", {
          nickname: "Racers",
          isActive: false,
        }),
      );
      expect(patchRes.status).toBe(200);
      const updated = await patchRes.json();
      expect(updated.nickname).toBe("Racers");
      expect(updated.displayName).toBe("Racers");
      expect(updated.isActive).toBe(false);
      expect(updated.retiredAt).not.toBeNull();

      const activeList = await (await app.fetch(new Request("http://test/api/v1/gear"))).json();
      expect(activeList.data.some((g: { id: number }) => g.id === created.id)).toBe(false);

      const fullList = await (
        await app.fetch(new Request("http://test/api/v1/gear?includeRetired=true"))
      ).json();
      expect(fullList.data.some((g: { id: number }) => g.id === created.id)).toBe(true);
    }));

  it("404s when updating another user's gear", async () => {
    const foreign = await withIdentity(
      { userId: otherUser.id, clerkUserId: otherUser.clerkId, role: "premium" },
      () => createGear({ model: "Foreign Shoe", surface: "TRAIL" }),
    );
    await withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq(`http://test/api/v1/gear/${foreign.id}`, "PATCH", { nickname: "mine now" }),
      );
      expect(res.status).toBe(404);
    });
  });

  it("assigns and clears a shoe on an activity, maintaining the gear's counters", () =>
    withIdentity(identity(), async () => {
      const gear = await createGear({ model: "Assign Target", surface: "ROAD" });
      const activity = await insertActivity(user.id, { distance: 10_000 });

      const assignRes = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${activity.id}/gear`, "PATCH", {
          gearId: gear.id,
        }),
      );
      expect(assignRes.status).toBe(200);
      const assigned = await assignRes.json();
      expect(assigned.gear).toMatchObject({ id: gear.id, model: "Assign Target" });

      const afterAssign = await (
        await app.fetch(new Request("http://test/api/v1/gear"))
      ).json();
      const g1 = afterAssign.data.find((g: { id: number }) => g.id === gear.id);
      expect(g1.activityCount).toBe(1);
      expect(g1.distanceMeters).toBe(10_000);

      const clearRes = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${activity.id}/gear`, "PATCH", { gearId: null }),
      );
      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.gear).toBeNull();

      const afterClear = await (await app.fetch(new Request("http://test/api/v1/gear"))).json();
      const g2 = afterClear.data.find((g: { id: number }) => g.id === gear.id);
      expect(g2.activityCount).toBe(0);
      expect(g2.distanceMeters).toBe(0);
    }));

  it("404s when assigning gear on another user's activity", async () => {
    const gear = await withIdentity(identity(), () =>
      createGear({ model: "Own Shoe", surface: "ROAD" }),
    );
    const foreignActivity = await insertActivity(otherUser.id, {});
    await withIdentity(identity(), async () => {
      const res = await app.fetch(
        jsonReq(`http://test/api/v1/activity/${foreignActivity.id}/gear`, "PATCH", {
          gearId: gear.id,
        }),
      );
      expect(res.status).toBe(404);
    });
  });
});
