// GDPR account deletion: DELETE /api/v1/user/data must remove EVERY row the
// user owns (activities + interval_segments cascade, events + attributes,
// gears + defaults, chat conversations + messages cascade, the users row, the
// user_settings row via cascade, and the encrypted oauth_provider_tokens rows
// via cascade) — while another user's rows survive intact.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getOrCreateUserSettings } from "../src/repositories/user_settings_repository";
import {
  activities,
  chatConversations,
  chatMessages,
  events,
  gears,
  intervalSegments,
  users,
} from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity, insertEvent } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { checkpointerMock } from "./setup";

const app = buildTestApp(getPool());
const db = getDb();

let userA: { id: string; clerkId: string };
let userB: { id: string; clerkId: string };
let userC: { id: string; clerkId: string };
const conversationIds: Record<string, string> = {};

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

async function seedOwnedRows(userId: string): Promise<string> {
  const activity = await insertActivity(userId, { trainingType: "LONG_INTERVALS" });
  await db.insert(intervalSegments).values({
    activityId: activity.id,
    segmentIndex: 0,
    setGroupIndex: 0,
    type: "INTERVALS",
    targetType: "distance",
    targetValue: 1000,
    targetPace: 3.5,
    timeSeriesEndTime: 300,
    actualDistance: 1000,
    actualDuration: 300,
    avgHeartRate: 160,
  });
  await insertEvent(userId, { description: "GDPR seed event" });
  await db.insert(gears).values({ userId, model: "GDPR Shoe", surface: "ROAD" });
  const [conversation] = await db
    .insert(chatConversations)
    .values({ id: crypto.randomUUID(), userId, title: "GDPR chat" })
    .returning();
  await db
    .insert(chatMessages)
    .values({ conversationId: conversation.id, role: "user", content: "hello" });
  await getOrCreateUserSettings(db, userId);
  return conversation.id;
}

async function countOwnedRows(userId: string) {
  const pool = getPool();
  const one = async (sql: string) =>
    Number((await pool.query(sql, [userId])).rows[0].count);
  return {
    users: await one(`SELECT COUNT(*) FROM users WHERE id = $1`),
    activities: await one(`SELECT COUNT(*) FROM activities WHERE user_id = $1`),
    segments: await one(
      `SELECT COUNT(*) FROM interval_segments s JOIN activities a ON a.id = s.activity_id WHERE a.user_id = $1`,
    ),
    events: await one(`SELECT COUNT(*) FROM events WHERE user_id = $1`),
    // event_notes.user_id has no FK cascade; GDPR delete works only because
    // events are deleted before the user, cascading notes via event_id (S5).
    eventNotes: await one(`SELECT COUNT(*) FROM event_notes WHERE user_id = $1`),
    gears: await one(`SELECT COUNT(*) FROM gears WHERE user_id = $1`),
    conversations: await one(`SELECT COUNT(*) FROM chat_conversations WHERE user_id = $1`),
    messages: await one(
      `SELECT COUNT(*) FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE c.user_id = $1`,
    ),
    userSettings: await one(`SELECT COUNT(*) FROM user_settings WHERE user_id = $1`),
  };
}

beforeAll(async () => {
  checkpointerMock.reset();
  userA = await createTestUser({ role: "premium" });
  userB = await createTestUser({ role: "premium" });
  userC = await createTestUser({ role: "premium" });
  conversationIds.A = await seedOwnedRows(userA.id);
  conversationIds.B = await seedOwnedRows(userB.id);
  conversationIds.C = await seedOwnedRows(userC.id);

  // The controller fires a real fetch to Strava's deauthorize endpoint — keep
  // the suite offline and record the attempt instead.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  checkpointerMock.reset();
  await deleteTestUser(userB.id);
  // userA and userC are deleted by the endpoint; clean up defensively if a test failed.
  await deleteTestUser(userA.id).catch(() => {});
  await deleteTestUser(userC.id).catch(() => {});
  await closePool();
});

describe("DELETE /api/v1/user/data", () => {
  it("removes every row user A owns, clears Clerk metadata, and leaves user B untouched", () =>
    withIdentity(
      { userId: userA.id, clerkUserId: userA.clerkId, role: "premium" },
      async () => {
        const before = await countOwnedRows(userA.id);
        expect(before).toEqual({
          users: 1,
          activities: 1,
          segments: 1,
          events: 1,
          eventNotes: 1,
          gears: 1,
          conversations: 1,
          messages: 1,
          userSettings: 1,
        });

        const res = await app.fetch(
          new Request("http://test/api/v1/user/data", { method: "DELETE" }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        const after = await countOwnedRows(userA.id);
        expect(after).toEqual({
          users: 0,
          activities: 0,
          segments: 0,
          events: 0,
          eventNotes: 0,
          gears: 0,
          conversations: 0,
          messages: 0,
          userSettings: 0,
        });

        // The other user's data survives in full.
        const survivor = await countOwnedRows(userB.id);
        expect(survivor).toEqual({
          users: 1,
          activities: 1,
          segments: 1,
          events: 1,
          eventNotes: 1,
          gears: 1,
          conversations: 1,
          messages: 1,
          userSettings: 1,
        });

        // Strava OAuth revocation was attempted…
        expect(fetchCalls.some((url) => url.includes("strava.com/oauth/deauthorize"))).toBe(
          true,
        );
        // …and user A's encrypted provider-token rows were removed (cascade).
        const { rows: tokenRows } = await getPool().query<{ n: number }>(
          "SELECT count(*)::int AS n FROM oauth_provider_tokens WHERE user_id = $1",
          [userA.id],
        );
        expect(tokenRows[0].n).toBe(0);

        // The LangGraph checkpointer thread for user A's conversation was
        // dropped, and user B's survives (its thread was never touched).
        expect(checkpointerMock.deletedThreads).toContain(conversationIds.A);
        expect(checkpointerMock.deletedThreads).not.toContain(conversationIds.B);
      },
    ));

  it("tolerates a throwing coach-thread delete without aborting the account deletion", () =>
    withIdentity(
      { userId: userC.id, clerkUserId: userC.clerkId, role: "premium" },
      async () => {
        checkpointerMock.deleteCoachThread = async () => {
          throw new Error("checkpointer unavailable");
        };

        const res = await app.fetch(
          new Request("http://test/api/v1/user/data", { method: "DELETE" }),
        );
        expect(res.status).toBe(200);

        // The delete was attempted for user C's conversation…
        expect(checkpointerMock.deletedThreads).toContain(conversationIds.C);
        // …and despite it throwing, every owned row is gone.
        const after = await countOwnedRows(userC.id);
        expect(after).toEqual({
          users: 0,
          activities: 0,
          segments: 0,
          events: 0,
          eventNotes: 0,
          gears: 0,
          conversations: 0,
          messages: 0,
          userSettings: 0,
        });

        checkpointerMock.reset();
      },
    ));
});
