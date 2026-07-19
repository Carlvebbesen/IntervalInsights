import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertRaceEvent } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let otherUser: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  otherUser = await createTestUser({ role: "premium" });
  await insertRaceEvent(user.id, {
    name: "Spring 10k",
    date: "2026-04-01",
    priority: "B",
    status: "upcoming",
  });
  await insertRaceEvent(user.id, {
    name: "Fall Marathon",
    date: "2026-10-01",
    priority: "A",
    status: "upcoming",
  });
  await insertRaceEvent(otherUser.id, { name: "Other user's race", date: "2026-05-01" });
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

describe("/api/v1/race-events", () => {
  it("GET / lists only the user's race events, ordered by date ascending", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/race-events"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(2);
      expect(body.data[0].name).toBe("Spring 10k");
      expect(body.data[1].name).toBe("Fall Marathon");
      expect(body.data.some((r: { name: string }) => r.name === "Other user's race")).toBe(false);
    }));

  it("GET /?status=upcoming filters by status", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/race-events?status=upcoming"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(2);
    }));

  it("POST / creates a race event", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/race-events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Winter Half",
            date: "2027-01-15",
            distanceMeters: 21097,
            targetTimeSeconds: 5400,
            priority: "A",
          }),
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("Winter Half");
      expect(body.priority).toBe("A");
      expect(body.status).toBe("upcoming");
    }));

  it("PATCH /:id edits a race event", () =>
    withIdentity(identity(), async () => {
      const created = await insertRaceEvent(user.id, { name: "To Edit", date: "2026-06-01" });
      const res = await app.fetch(
        new Request(`http://test/api/v1/race-events/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "completed" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
    }));

  it("PATCH /:id 404s for another user's race event", () =>
    withIdentity(identity(), async () => {
      const otherRace = await insertRaceEvent(otherUser.id, {
        name: "Not yours",
        date: "2026-06-01",
      });
      const res = await app.fetch(
        new Request(`http://test/api/v1/race-events/${otherRace.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        }),
      );
      expect(res.status).toBe(404);
    }));

  it("DELETE /:id removes a race event", () =>
    withIdentity(identity(), async () => {
      const created = await insertRaceEvent(user.id, { name: "To Delete", date: "2026-06-01" });
      const res = await app.fetch(
        new Request(`http://test/api/v1/race-events/${created.id}`, { method: "DELETE" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const listRes = await app.fetch(new Request("http://test/api/v1/race-events"));
      const listBody = await listRes.json();
      expect(
        listBody.data.some((r: { id: number }) => r.id === created.id),
      ).toBe(false);
    }));
});
