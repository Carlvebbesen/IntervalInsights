import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity, insertEvent } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let other: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  other = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(other.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

const otherIdentity = () => ({
  userId: other.id,
  clerkUserId: other.clerkId,
  role: "premium" as const,
});

const linkRequest = (eventId: number, activityId: number) =>
  new Request(`http://test/api/v1/events/${eventId}/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activityId }),
  });

async function joinCount(eventId: number): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM activity_events WHERE event_id = $1",
    [eventId],
  );
  return rows[0].n;
}

async function noteCount(eventId: number): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM event_notes WHERE event_id = $1",
    [eventId],
  );
  return rows[0].n;
}

async function lastOccurrence(eventId: number): Promise<Date> {
  const { rows } = await getPool().query<{ last_occurrence: Date }>(
    "SELECT last_occurrence FROM events WHERE id = $1",
    [eventId],
  );
  return rows[0].last_occurrence;
}

async function activityStart(activityId: number): Promise<Date> {
  const { rows } = await getPool().query<{ start_date_local: Date }>(
    "SELECT start_date_local FROM activities WHERE id = $1",
    [activityId],
  );
  return rows[0].start_date_local;
}

describe("POST /api/v1/events/:id/link", () => {
  it("links an existing event to an activity and returns the ActivityEvent shape", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Tempo" });
      const ev = await insertEvent(user.id, {
        eventType: "INJURY",
        bodyLocation: "left knee",
        description: "Knee ache on the descent",
      });

      const res = await app.fetch(linkRequest(ev.id, activity.id));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.id).toBe(ev.id);
      expect(body.eventType).toBe("INJURY");
      expect(body.bodyLocation).toBe("left knee");
      expect(body.status).toBe("active");
      expect(body.resolvedAt).toBeNull();
      expect(typeof body.startTime).toBe("string");
      expect(typeof body.lastOccurrence).toBe("string");
      expect(body.anchorNote.note).toBe("Knee ache on the descent");
      expect(body.anchorNote.isAnchor).toBe(true);
      expect(body.latestNote).toBeUndefined();

      expect(await joinCount(ev.id)).toBe(1);
    }));

  it("is idempotent: re-linking returns 200 with the same body and one join row", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Repeat" });
      const ev = await insertEvent(user.id, { description: "Same ache" });

      const first = await app.fetch(linkRequest(ev.id, activity.id));
      const second = await app.fetch(linkRequest(ev.id, activity.id));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(secondBody).toEqual(firstBody);
      expect(await joinCount(ev.id)).toBe(1);
    }));

  it("bumps lastOccurrence only when the activity starts later than the current value", () =>
    withIdentity(identity(), async () => {
      const start = new Date("2026-01-05T09:00:00Z");
      const ev = await insertEvent(user.id, {
        description: "Recurring calf strain",
        startTime: start,
        lastOccurrence: start,
      });
      const before = await lastOccurrence(ev.id);

      const newer = await insertActivity(user.id, {
        title: "Later run",
        startDateLocal: new Date("2026-03-05T09:00:00Z"),
      });
      await app.fetch(linkRequest(ev.id, newer.id));
      const bumped = await lastOccurrence(ev.id);
      expect(bumped.getTime()).toBeGreaterThan(before.getTime());
      expect(bumped.getTime()).toBe((await activityStart(newer.id)).getTime());

      const older = await insertActivity(user.id, {
        title: "Earlier run",
        startDateLocal: new Date("2026-02-01T09:00:00Z"),
      });
      await app.fetch(linkRequest(ev.id, older.id));
      expect((await lastOccurrence(ev.id)).getTime()).toBe(bumped.getTime());
    }));

  it("appends no note — a manual link is not a detected recurrence", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Silent link" });
      const ev = await insertEvent(user.id, { description: "Anchor only" });
      const before = await noteCount(ev.id);

      const res = await app.fetch(linkRequest(ev.id, activity.id));
      expect(res.status).toBe(200);
      expect(await noteCount(ev.id)).toBe(before);
    }));
});

describe("POST /api/v1/events/:id/link ownership", () => {
  it("404s for another user's event, without creating a link", async () => {
    const ev = await insertEvent(user.id, { description: "not yours" });
    const activity = await insertActivity(other.id, { title: "Other's run" });

    await withIdentity(otherIdentity(), async () => {
      const res = await app.fetch(linkRequest(ev.id, activity.id));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toBe("Event or activity not found or unauthorized");
      expect(body.error).not.toContain("not yours");
    });

    expect(await joinCount(ev.id)).toBe(0);
  });

  it("404s for another user's activity, without creating a link", async () => {
    const ev = await insertEvent(other.id, { description: "other's event" });
    const activity = await insertActivity(user.id, { title: "user's run" });

    await withIdentity(otherIdentity(), async () => {
      const res = await app.fetch(linkRequest(ev.id, activity.id));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Event or activity not found or unauthorized");
    });

    expect(await joinCount(ev.id)).toBe(0);
  });

  it("404s for nonexistent ids with the same generic message", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Exists" });
      const ev = await insertEvent(user.id, { description: "Exists" });

      const missingEvent = await app.fetch(linkRequest(2_000_000_000, activity.id));
      expect(missingEvent.status).toBe(404);
      expect((await missingEvent.json()).error).toBe(
        "Event or activity not found or unauthorized",
      );

      const missingActivity = await app.fetch(linkRequest(ev.id, 2_000_000_000));
      expect(missingActivity.status).toBe(404);
      expect((await missingActivity.json()).error).toBe(
        "Event or activity not found or unauthorized",
      );
    }));
});

describe("GET /api/v1/events?activityId=", () => {
  it("returns only that activity's linked events in the {events} envelope", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Linked run" });
      const otherActivity = await insertActivity(user.id, { title: "Unrelated run" });
      const first = await insertEvent(user.id, { eventType: "INJURY", description: "Shin" });
      const second = await insertEvent(user.id, { eventType: "ILLNESS", description: "Cough" });
      const unrelated = await insertEvent(user.id, { description: "Elsewhere" });

      await app.fetch(linkRequest(first.id, activity.id));
      await app.fetch(linkRequest(second.id, activity.id));
      await app.fetch(linkRequest(unrelated.id, otherActivity.id));

      const res = await app.fetch(
        new Request(`http://test/api/v1/events?activityId=${activity.id}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.map((e: { id: number }) => e.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      for (const e of body.events) {
        expect(e.anchorNote).not.toBeNull();
        expect(e.anchorNote.isAnchor).toBe(true);
        expect(e.latestNote).toBeUndefined();
      }
    }));

  it("returns an empty list for an activity with no linked events", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Nothing linked" });
      const res = await app.fetch(
        new Request(`http://test/api/v1/events?activityId=${activity.id}`),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ events: [] });
    }));

  it("404s for another user's activityId", async () => {
    const activity = await insertActivity(other.id, { title: "Other's run" });
    await withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/events?activityId=${activity.id}`),
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Event or activity not found or unauthorized");
    });
  });

  it("ignores the status and eventType filters when activityId is present", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Mixed" });
      const active = await insertEvent(user.id, { eventType: "INJURY", description: "Active" });
      const resolved = await insertEvent(user.id, {
        eventType: "ILLNESS",
        description: "Resolved",
        status: "resolved",
      });
      await app.fetch(linkRequest(active.id, activity.id));
      await app.fetch(linkRequest(resolved.id, activity.id));

      const res = await app.fetch(
        new Request(
          `http://test/api/v1/events?activityId=${activity.id}&status=active&eventType=INJURY`,
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events.map((e: { id: number }) => e.id).sort()).toEqual(
        [active.id, resolved.id].sort(),
      );
    }));

  it("still honours status/eventType when activityId is absent", () =>
    withIdentity(identity(), async () => {
      const medical = await insertEvent(user.id, {
        eventType: "MEDICAL_VISIT",
        description: "Doctor",
      });

      const byType = await app.fetch(
        new Request("http://test/api/v1/events?eventType=MEDICAL_VISIT"),
      );
      const byTypeBody = await byType.json();
      expect(byTypeBody.events.map((e: { id: number }) => e.id)).toContain(medical.id);
      for (const e of byTypeBody.events) {
        expect(e.eventType).toBe("MEDICAL_VISIT");
        expect(e.latestNote).not.toBeUndefined();
      }

      const byStatus = await app.fetch(new Request("http://test/api/v1/events?status=resolved"));
      const byStatusBody = await byStatus.json();
      expect(byStatusBody.events.length).toBeGreaterThan(0);
      for (const e of byStatusBody.events) {
        expect(e.status).toBe("resolved");
      }
    }));
});
