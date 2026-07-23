// The user-facing side of MCP connections: list the OAuth clients a user has
// authorized (Claude, ChatGPT, …) and disconnect one. Disconnecting must drop
// the consent and every token issued to that client for the user, so the client
// cannot keep calling and must re-consent to reconnect.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; email: string };
let otherUser: { id: string; email: string };
const createdClientIds: string[] = [];

const identity = (id: string) => ({ userId: id, role: "premium" as const });

async function seedClient(name: string): Promise<string> {
  const clientId = `conn_test_${randomUUID()}`;
  await getPool().query(
    `INSERT INTO oauth_clients (client_id, redirect_uris, name, uri)
     VALUES ($1, ARRAY['https://c.test/cb'], $2, 'https://c.test')`,
    [clientId, name],
  );
  createdClientIds.push(clientId);
  return clientId;
}

async function connect(userId: string, clientId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_consents (client_id, user_id, scopes) VALUES ($1, $2, $3)`,
    [clientId, userId, ["profile", "email"]],
  );
  await getPool().query(
    `INSERT INTO oauth_access_tokens (token, client_id, user_id, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5)`,
    [`tok_${randomUUID()}`, clientId, userId, new Date(Date.now() + 3_600_000), ["profile"]],
  );
}

const rowCount = async (table: string, clientId: string, userId: string): Promise<number> => {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM ${table} WHERE client_id = $1 AND user_id = $2`,
    [clientId, userId],
  );
  return rows[0].n;
};

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  otherUser = await createTestUser({ role: "premium" });
});

afterEach(async () => {
  const pool = getPool();
  for (const clientId of createdClientIds) {
    await pool.query(`DELETE FROM oauth_access_tokens WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_consents WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
  }
  createdClientIds.length = 0;
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await deleteTestUser(otherUser.id);
  await closePool();
});

describe("GET /api/v1/user/connections", () => {
  it("lists only the caller's connected clients, with name and scopes", async () => {
    const mine = await seedClient("Claude");
    const theirs = await seedClient("Someone else's ChatGPT");
    await connect(user.id, mine);
    await connect(otherUser.id, theirs);

    await withIdentity(identity(user.id), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/user/connections"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        clientId: mine,
        name: "Claude",
        uri: "https://c.test",
        scopes: ["profile", "email"],
      });
      expect(typeof body.data[0].connectedAt).toBe("string");
    });
  });

  it("returns an empty list when nothing is connected", async () => {
    await withIdentity(identity(user.id), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/user/connections"));
      expect((await res.json()).data).toEqual([]);
    });
  });
});

describe("DELETE /api/v1/user/connections/:clientId", () => {
  it("drops the consent and all tokens for that client", async () => {
    const clientId = await seedClient("Claude");
    await connect(user.id, clientId);
    expect(await rowCount("oauth_access_tokens", clientId, user.id)).toBe(1);

    await withIdentity(identity(user.id), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/user/connections/${clientId}`, { method: "DELETE" }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });

    expect(await rowCount("oauth_consents", clientId, user.id)).toBe(0);
    expect(await rowCount("oauth_access_tokens", clientId, user.id)).toBe(0);
  });

  it("404s an unknown or unconnected client", async () => {
    await withIdentity(identity(user.id), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/user/connections/${randomUUID()}`, { method: "DELETE" }),
      );
      expect(res.status).toBe(404);
    });
  });

  it("cannot disconnect another user's connection", async () => {
    const clientId = await seedClient("Claude");
    await connect(otherUser.id, clientId);

    await withIdentity(identity(user.id), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/user/connections/${clientId}`, { method: "DELETE" }),
      );
      expect(res.status).toBe(404);
    });

    // the other user's grant is untouched
    expect(await rowCount("oauth_consents", clientId, otherUser.id)).toBe(1);
  });
});
