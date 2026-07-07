import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertEvent } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  await insertEvent(user.id, { eventType: "INJURY", description: "Achilles" });
  await insertEvent(user.id, {
    eventType: "ILLNESS",
    description: "Cold",
    status: "resolved",
  });
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

describe("/api/events", () => {
  it("GET / returns all events for the user", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/events"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBe(2);
    }));

  it("GET /?status=resolved filters by status", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/events?status=resolved"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events.length).toBe(1);
      expect(body.events[0].status).toBe("resolved");
    }));

  it("GET /?eventType=INJURY filters by type", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/events?eventType=INJURY"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events.length).toBe(1);
      expect(body.events[0].eventType).toBe("INJURY");
    }));
});
