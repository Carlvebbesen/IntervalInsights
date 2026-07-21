import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity, insertEvent, insertEventNote, linkEventToActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; email: string };
let other: { id: string; email: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  other = await createTestUser({ role: "premium" });
  await insertEvent(user.id, { eventType: "INJURY", description: "Achilles" });
  await insertEvent(user.id, {
    eventType: "ILLNESS",
    description: "Cold",
    status: "resolved",
  });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(other.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  role: "premium" as const,
});

const otherIdentity = () => ({
  userId: other.id,
  role: "premium" as const,
});

const json = (url: string, method: string, body: unknown) =>
  new Request(`http://test${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("/api/events GET", () => {
  it("GET / returns all events for the user, each with its anchor note", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/events"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBe(2);
      for (const e of body.events) {
        expect(e.anchorNote).not.toBeNull();
        expect(e.anchorNote.isAnchor).toBe(true);
        expect(typeof e.anchorNote.note).toBe("string");
        expect(e.latestNote).not.toBeNull();
      }
    }));

  it("GET /?status=resolved filters by status", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/events?status=resolved"));
      const body = await res.json();
      expect(body.events.length).toBe(1);
      expect(body.events[0].status).toBe("resolved");
    }));

  it("GET /?eventType=INJURY filters by type", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/events?eventType=INJURY"));
      const body = await res.json();
      expect(body.events.length).toBe(1);
      expect(body.events[0].eventType).toBe("INJURY");
    }));
});

describe("/api/events standalone create + detail + delete", () => {
  it("POST / with no activityId creates a standalone event with an anchor note", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        json("/api/v1/events", "POST", {
          eventType: "OTHER",
          note: "Blister on right heel",
        }),
      );
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created.anchorNote.note).toBe("Blister on right heel");
      expect(created.anchorNote.source).toBe("user");

      const detailRes = await app.fetch(new Request(`http://test/api/v1/events/${created.id}`));
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.event.id).toBe(created.id);
      expect(detail.notes.length).toBe(1);
      expect(detail.notes[0].isAnchor).toBe(true);
      expect(detail.linkedActivities.length).toBe(0);

      const del = await app.fetch(new Request(`http://test/api/v1/events/${created.id}`, {
        method: "DELETE",
      }));
      expect(del.status).toBe(200);
      const delBody = await del.json();
      expect(delBody.deleted).toBe(true);

      const gone = await app.fetch(new Request(`http://test/api/v1/events/${created.id}`));
      expect(gone.status).toBe(404);
    }));

  it("POST / with activityId links the event and reports it in the detail", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Long run" });
      const res = await app.fetch(
        json("/api/v1/events", "POST", {
          activityId: activity.id,
          eventType: "INJURY",
          bodyLocation: "left knee",
          note: "Knee ache on the descent",
        }),
      );
      expect(res.status).toBe(201);
      const created = await res.json();
      const detail = await (
        await app.fetch(new Request(`http://test/api/v1/events/${created.id}`))
      ).json();
      expect(detail.linkedActivities.length).toBe(1);
      expect(detail.linkedActivities[0].id).toBe(activity.id);
      expect(detail.linkedActivities[0].name).toBe("Long run");
    }));

  it("GET /:id 404s for another user's event", () =>
    withIdentity(otherIdentity(), async () => {
      const ev = await insertEvent(user.id, { description: "private" });
      const res = await app.fetch(new Request(`http://test/api/v1/events/${ev.id}`));
      expect(res.status).toBe(404);
    }));
});

describe("/api/events notes CRUD", () => {
  it("POST /:id/notes appends a user note without changing status", () =>
    withIdentity(identity(), async () => {
      const ev = await insertEvent(user.id, { description: "Hip pain", status: "active" });
      const res = await app.fetch(
        json(`/api/v1/events/${ev.id}/notes`, "POST", {
          note: "A bit better today",
          trend: "improving",
          severity: 4,
        }),
      );
      expect(res.status).toBe(201);
      const note = await res.json();
      expect(note.source).toBe("user");
      expect(note.trend).toBe("improving");
      expect(note.severity).toBe(4);
      expect(note.isAnchor).toBe(false);

      const detail = await (
        await app.fetch(new Request(`http://test/api/v1/events/${ev.id}`))
      ).json();
      expect(detail.event.status).toBe("active");
      expect(detail.notes.length).toBe(2);
      expect(detail.event.latestNote.note).toBe("A bit better today");
    }));

  it("PATCH /:id/notes/:noteId edits the AI anchor note", () =>
    withIdentity(identity(), async () => {
      const ev = await insertEvent(user.id, { description: "Original AI summary" });
      const detail = await (
        await app.fetch(new Request(`http://test/api/v1/events/${ev.id}`))
      ).json();
      const anchorId = detail.notes[0].id;
      const res = await app.fetch(
        json(`/api/v1/events/${ev.id}/notes/${anchorId}`, "PATCH", {
          note: "Corrected summary",
        }),
      );
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.note).toBe("Corrected summary");
      expect(updated.isAnchor).toBe(true);
    }));

  it("DELETE /:id/notes/:noteId removes a non-anchor note", () =>
    withIdentity(identity(), async () => {
      const ev = await insertEvent(user.id, { description: "anchor" });
      const note = await insertEventNote(ev.id, user.id, { note: "extra" });
      const res = await app.fetch(new Request(`http://test/api/v1/events/${ev.id}/notes/${note.id}`, {
        method: "DELETE",
      }));
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);
    }));

  it("DELETE of the anchor note is rejected with 400", () =>
    withIdentity(identity(), async () => {
      const ev = await insertEvent(user.id, { description: "anchor" });
      const detail = await (
        await app.fetch(new Request(`http://test/api/v1/events/${ev.id}`))
      ).json();
      const anchorId = detail.notes[0].id;
      const res = await app.fetch(new Request(`http://test/api/v1/events/${ev.id}/notes/${anchorId}`, {
        method: "DELETE",
      }));
      expect(res.status).toBe(400);
    }));
});

describe("/api/events note-route ownership", () => {
  it("POST /:id/notes 404s for another user's event", () =>
    withIdentity(otherIdentity(), async () => {
      const ev = await insertEvent(user.id, { description: "not yours" });
      const res = await app.fetch(
        json(`/api/v1/events/${ev.id}/notes`, "POST", { note: "intrusion" }),
      );
      expect(res.status).toBe(404);
    }));

  it("PATCH /:id/notes/:noteId 404s across users", () =>
    withIdentity(otherIdentity(), async () => {
      const ev = await insertEvent(user.id, { description: "not yours" });
      const note = await insertEventNote(ev.id, user.id, { note: "victim note" });
      const res = await app.fetch(
        json(`/api/v1/events/${ev.id}/notes/${note.id}`, "PATCH", { note: "hijack" }),
      );
      expect(res.status).toBe(404);
    }));
});

describe("/api/events unlink vs delete", () => {
  it("DELETE /:id?activityId= unlinks and deletes when it was the last link", () =>
    withIdentity(identity(), async () => {
      const activity = await insertActivity(user.id, { title: "Tempo" });
      const ev = await insertEvent(user.id, { description: "linked once" });
      await linkEventToActivity(activity.id, ev.id);
      const res = await app.fetch(
        new Request(`http://test/api/v1/events/${ev.id}?activityId=${activity.id}`, {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.unlinked).toBe(true);
      expect(body.deleted).toBe(true);
    }));
});
