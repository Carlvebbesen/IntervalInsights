import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { clearTurnActive, markTurnActive } from "../src/controllers/active_turns";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { chatTitleMock, checkpointerMock, trainingGraphMock } from "./setup";

const app = buildTestApp(getPool());
const pool = getPool();

let user: { id: string; clerkId: string };
let other: { id: string; clerkId: string };
let guest: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  other = await createTestUser({ role: "premium" });
  guest = await createTestUser({ role: "guest" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(other.id);
  await deleteTestUser(guest.id);
  await closePool();
});

afterEach(() => {
  trainingGraphMock.reset();
  chatTitleMock.reset();
  checkpointerMock.reset();
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

const guestIdentity = () => ({
  userId: guest.id,
  clerkUserId: guest.clerkId,
  role: "guest" as const,
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

async function insertMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`,
    [conversationId, role, content],
  );
  return rows[0].id;
}

async function conversationTitle(conversationId: string): Promise<string> {
  const { rows } = await pool.query<{ title: string }>(
    `SELECT title FROM chat_conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0].title;
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

  it("generates an LLM title after the first clean exchange, once", () =>
    withIdentity(identity(), async () => {
      const conversationId = randomUUID();

      await (await postChat(conversationId, "How is my training?")).text();
      expect(await conversationTitle(conversationId)).toBe("AI generated title");

      // A second clean turn must NOT regenerate the title.
      chatTitleMock.generateConversationTitle = async () => "SECOND title";
      await (await postChat(conversationId, "And my recovery?")).text();
      expect(await conversationTitle(conversationId)).toBe("AI generated title");
    }));

  it("keeps the derived title when title generation fails", () =>
    withIdentity(identity(), async () => {
      chatTitleMock.generateConversationTitle = async () => {
        throw new Error("title boom");
      };
      const conversationId = randomUUID();
      const res = await postChat(conversationId, "Derived title please");
      const text = await res.text();
      expect(text).toContain("event: done");
      // ensureConversation seeded the derived-truncation title; it survives.
      expect(await conversationTitle(conversationId)).toBe("Derived title please");
    }));

  it("DELETE removes the conversation + messages and deletes the coach thread", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);
      await insertMessage(conversationId, "user", "q");
      await insertMessage(conversationId, "assistant", "a");

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`, {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(checkpointerMock.deletedThreads).toContain(conversationId);

      const convo = await pool.query(`SELECT id FROM chat_conversations WHERE id = $1`, [
        conversationId,
      ]);
      expect(convo.rowCount).toBe(0);
      const msgs = await fetchMessages(conversationId);
      expect(msgs).toHaveLength(0);
    }));

  it("DELETE by a non-owner returns 404 and deletes nothing", () =>
    withIdentity(otherIdentity(), async () => {
      const conversationId = await seedConversation(user.id);

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`, {
          method: "DELETE",
        }),
      );
      expect(res.status).toBe(404);
      expect(checkpointerMock.deletedThreads).toHaveLength(0);

      const convo = await pool.query(`SELECT id FROM chat_conversations WHERE id = $1`, [
        conversationId,
      ]);
      expect(convo.rowCount).toBe(1);
    }));

  it("PATCH renames a conversation and returns the updated object", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "  Renamed thread  " }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(conversationId);
      expect(body.title).toBe("Renamed thread");
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
      expect(await conversationTitle(conversationId)).toBe("Renamed thread");
    }));

  it("PATCH by a non-owner returns 404 and leaves the title unchanged", () =>
    withIdentity(otherIdentity(), async () => {
      const conversationId = await seedConversation(user.id);

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Hijacked" }),
        }),
      );
      expect(res.status).toBe(404);
      expect(await conversationTitle(conversationId)).toBe("Seeded");
    }));

  it("PATCH rejects an invalid title", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);

      const empty = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "   " }),
        }),
      );
      expect(empty.status).toBe(400);

      const tooLong = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "x".repeat(121) }),
        }),
      );
      expect(tooLong.status).toBe(400);
    }));

  it("GET returns the newest window ascending by default with paging meta", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);
      await insertMessage(conversationId, "user", "m1");
      await insertMessage(conversationId, "assistant", "m2");
      const m3 = await insertMessage(conversationId, "user", "m3");
      await insertMessage(conversationId, "assistant", "m4");

      const res = await app.fetch(
        new Request(`http://test/api/v1/chat/conversations/${conversationId}?limit=2`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages.map((m: { content: string }) => m.content)).toEqual(["m3", "m4"]);
      expect(body.meta.hasMore).toBe(true);
      expect(body.meta.nextBefore).toBe(m3);
    }));

  it("GET pages backwards with the before cursor", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);
      await insertMessage(conversationId, "user", "m1");
      await insertMessage(conversationId, "assistant", "m2");
      const m3 = await insertMessage(conversationId, "user", "m3");
      await insertMessage(conversationId, "assistant", "m4");

      const res = await app.fetch(
        new Request(
          `http://test/api/v1/chat/conversations/${conversationId}?limit=2&before=${m3}`,
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages.map((m: { content: string }) => m.content)).toEqual(["m1", "m2"]);
      expect(body.meta.hasMore).toBe(false);
      expect(body.meta.nextBefore).toBeNull();
    }));

  it("GET with a before cursor does not backfill a dangling user turn", () =>
    withIdentity(identity(), async () => {
      const conversationId = await seedConversation(user.id);
      await insertMessage(conversationId, "assistant", "old answer");
      const dangling = await insertMessage(conversationId, "user", "unanswered");

      const res = await app.fetch(
        new Request(
          `http://test/api/v1/chat/conversations/${conversationId}?limit=10&before=${dangling}`,
        ),
      );
      expect(res.status).toBe(200);

      // No interrupted assistant row was appended.
      const rows = await fetchMessages(conversationId);
      expect(rows.map((m) => m.role)).toEqual(["assistant", "user"]);
    }));

  it("a non-premium user can GET history but is 403'd on POST /", async () => {
    const conversationId = await withIdentity(identity(), async () => {
      const id = await seedConversation(user.id);
      return id;
    });

    await withIdentity(guestIdentity(), async () => {
      const list = await app.fetch(new Request("http://test/api/v1/chat/conversations"));
      expect(list.status).toBe(200);

      const post = await postChat(conversationId);
      expect(post.status).toBe(403);
    });
  });
});
