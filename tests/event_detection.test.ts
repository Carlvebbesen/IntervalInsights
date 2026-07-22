// Detection writes the note timeline: a NEW event gets an anchor note (source
// 'ai'); a RECURRENCE (LLM links to an existing event) appends a dated 'ai'
// note built from `updateText`, without adding a second anchor (D8/S3/S5).

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { eventNotes } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity, insertEvent, linkEventToActivity } from "./helpers/fixtures";

// Mutable holder so each test can drive the "LLM" output.
let mockDetection: unknown = { events: [] };
mock.module("../src/agent/event_detection_agent.ts", () => ({
  invokeEventDetectionAgent: async () => mockDetection,
}));

const { detectAndPersistEvents } = await import("../src/services/event_detection_service");

const db = getDb();
let user: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const notesFor = (eventId: number) =>
  db.select().from(eventNotes).where(eq(eventNotes.eventId, eventId));

describe("detectAndPersistEvents note timeline", () => {
  it("writes an anchor note (source ai) for a brand-new event", async () => {
    const activity = await insertActivity(user.id, { title: "Run" });
    mockDetection = {
      events: [
        {
          linkedEventId: null,
          eventType: "INJURY",
          bodyLocation: "right hip",
          description: "Smerter i høyre hofte",
          updateText: "Vondt i høyre hofte i dag",
          markResolved: false,
          attributes: [],
        },
      ],
    };

    await detectAndPersistEvents(db as never, {
      activityId: activity.id,
      userId: user.id,
      title: "Run",
      description: "",
      notes: "vondt i høyre hofte",
      activityStartDateLocal: new Date(),
    });

    const { rows } = await getPool().query<{ id: number }>(
      "SELECT id FROM events WHERE user_id = $1 AND body_location = 'right hip'",
      [user.id],
    );
    expect(rows.length).toBe(1);
    const notes = await notesFor(rows[0].id);
    expect(notes.length).toBe(1);
    expect(notes[0].isAnchor).toBe(true);
    expect(notes[0].source).toBe("ai");
    expect(notes[0].note).toBe("Smerter i høyre hofte");
  });

  it("appends a dated ai note (from updateText) on a recurrence, keeping one anchor", async () => {
    const existing = await insertEvent(user.id, {
      eventType: "INJURY",
      bodyLocation: "left knee",
      description: "Smerter i venstre kne",
    });
    const activity = await insertActivity(user.id, { title: "Long run" });
    mockDetection = {
      events: [
        {
          linkedEventId: existing.id,
          eventType: "INJURY",
          bodyLocation: "left knee",
          description: "Smerter i venstre kne",
          updateText: "Fortsatt vondt i venstre kne etter dagens langtur",
          markResolved: false,
          attributes: [],
        },
      ],
    };

    await detectAndPersistEvents(db as never, {
      activityId: activity.id,
      userId: user.id,
      title: "Long run",
      description: "",
      notes: "fortsatt vondt i venstre kne",
      activityStartDateLocal: new Date(),
    });

    const notes = await notesFor(existing.id);
    expect(notes.length).toBe(2);
    expect(notes.filter((n) => n.isAnchor).length).toBe(1);
    const appended = notes.find((n) => !n.isAnchor);
    expect(appended?.source).toBe("ai");
    expect(appended?.note).toBe("Fortsatt vondt i venstre kne etter dagens langtur");
  });

  it("skips an event the user manually linked to this activity — no second link, no note", async () => {
    const existing = await insertEvent(user.id, {
      eventType: "INJURY",
      bodyLocation: "right calf",
      description: "Stram høyre legg",
    });
    const activity = await insertActivity(user.id, { title: "Threshold" });
    await linkEventToActivity(activity.id, existing.id);

    mockDetection = {
      events: [
        {
          linkedEventId: existing.id,
          eventType: "INJURY",
          bodyLocation: "right calf",
          description: "Stram høyre legg",
          updateText: "Fortsatt stram legg",
          markResolved: false,
          attributes: [],
        },
      ],
    };

    await detectAndPersistEvents(db as never, {
      activityId: activity.id,
      userId: user.id,
      title: "Threshold",
      description: "",
      notes: "fortsatt stram legg",
      activityStartDateLocal: new Date(),
    });

    const { rows } = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM activity_events WHERE event_id = $1",
      [existing.id],
    );
    expect(rows[0].n).toBe(1);
    expect((await notesFor(existing.id)).length).toBe(1);
  });
});
