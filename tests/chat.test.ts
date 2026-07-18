import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { clearTurnActive, markTurnActive } from "../src/controllers/active_turns";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { trainingGraphMock } from "./setup";

const app = buildTestApp(getPool());
const pool = getPool();

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

afterEach(() => {
  trainingGraphMock.reset();
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

async function seedConversation(ownerId: string, updatedAt?: string): Promise<string> {
  const id = randomUUID();
  if (updatedAt) {
    await pool.query(
      `INSERT INTO chat_conversations (id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, ownerId, "Seeded", updatedAt],
    );
  } else {
    await pool.query(
      `INSERT INTO chat_conversations (id, user_id, title) VALUES ($1, $2, $3)`,
      [id, ownerId, "Seeded"],
    );
  }
  return id;
}

async function insertUserMessage(conversationId: string, content: string): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
    [conversationId, content],
  );
}

async function fetchMessages(
  conversationId: string,
): Promise<{ role: string; content: string; status: string | null }[]> {
  const { rows } = await pool.query<{ role: string; content: string; status: string | null }>(
    `SELECT role, content, status FROM chat_messages
     WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );
  return rows;
}

async function conversationUpdatedAt(conversationId: string): Promise<string> {
  const { rows } = await pool.query<{ updated_at: string }>(
    `SELECT updated_at FROM chat_conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0].updated_at;
}

function postChat(conversationId: string, message = "How is my training?") {
  return app.fetch(
    new Request("http://test/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        message,
        userTime: new Date().toISOString(),
      }),
    }),
  );
}

describe("/api/v1/chat", () => {
  it("persists a user + assistant (status null) pair on a clean turn", () =>
    withIdentity(identity(), async () => {
      const conversationId = randomUUID();
      const res = await postChat(conversationId);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("event: done");

      const messages = await fetchMessages(conversationId);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1].status).toBeNull();
      expect(messages[1].content).toContain("training answer");
    }));

  it("GET /conversations/:id returns the status field", () =>
    withIdentity(identity(), async () => {
      const conversationId = randomUUID();
      await (await postChat(conversationId)).text();

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const assistant = body.messages.find((m: { role: string }) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant.status).toBeNull();
    }));

  it("on graph error, persists an assistant row with status 'error' and emits SSE error", () =>
    withIdentity(identity(), async () => {
      trainingGraphMock.stream = async function* () {
        throw new Error("graph boom");
      };
      const conversationId = randomUUID();
      const res = await postChat(conversationId);
      const text = await res.text();
      expect(text).toContain("event: error");

      const messages = await fetchMessages(conversationId);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1].status).toBe("error");
    }));

  it("on assistant-persist failure, emits SSE error and does not fake success", () =>
    withIdentity(identity(), async () => {
      // A NUL byte in the answer makes the Postgres text insert throw.
      trainingGraphMock.stream = async function* () {
        const bad = `bad${String.fromCharCode(0)}answer`;
        yield ["values", { finalAnswer: bad, pendingArtifacts: null }];
      };
      const conversationId = randomUUID();
      const res = await postChat(conversationId);
      const text = await res.text();
      expect(text).toContain("event: error");
      expect(text).not.toContain("event: done");

      const messages = await fetchMessages(conversationId);
      // User row persisted; assistant insert failed, so no assistant row.
      expect(messages.map((m) => m.role)).toEqual(["user"]);
    }));

  it("does not bump updatedAt on an ownership-failed turn, but does on a clean turn", async () => {
    const oldTs = "2020-01-01T00:00:00.000Z";

    // Ownership failure: conversation owned by `user`, posted by `other`.
    const ownedId = await seedConversation(user.id, oldTs);
    await withIdentity(otherIdentity(), async () => {
      const res = await postChat(ownedId);
      const text = await res.text();
      expect(text).toContain("event: error");
    });
    const afterFail = await conversationUpdatedAt(ownedId);
    expect(new Date(afterFail).toISOString()).toBe(new Date(oldTs).toISOString());

    // Clean turn bumps updatedAt.
    const freshId = await seedConversation(user.id, oldTs);
    await withIdentity(identity(), async () => {
      await (await postChat(freshId)).text();
    });
    const afterOk = await conversationUpdatedAt(freshId);
    expect(new Date(afterOk).getTime()).toBeGreaterThan(new Date(oldTs).getTime());
  });

  it("GET backfills a trailing user message with an interrupted assistant row", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);
      await insertUserMessage(conversationId, "unanswered question");

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const last = body.messages[body.messages.length - 1];
      expect(last.role).toBe("assistant");
      expect(last.status).toBe("interrupted");
      expect(last.content).toBe("");

      // Persisted, not just synthesized in the response.
      const rows = await fetchMessages(conversationId);
      expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(rows[1].status).toBe("interrupted");
    }));

  it("does NOT backfill a conversation with an in-flight turn", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);
      await insertUserMessage(conversationId, "in-flight question");
      markTurnActive(conversationId);
      try {
        const res = await app.fetch(
          new Request(`http://test/api/v1/chat/conversations/${conversationId}`),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe("user");
      } finally {
        clearTurnActive(conversationId);
      }

      const rows = await fetchMessages(conversationId);
      expect(rows.map((m) => m.role)).toEqual(["user"]);
    }));
});
