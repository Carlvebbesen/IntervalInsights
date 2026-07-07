import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, getPool } from "./helpers/db";
import { buildTestApp } from "./helpers/test_app";

const app = buildTestApp(getPool());

beforeAll(() => {
  // ensure pool is created at module load
  getPool();
});

afterAll(async () => {
  await closePool();
});

describe("public endpoints (no auth)", () => {
  it("GET /api/health returns 200", async () => {
    const res = await app.fetch(new Request("http://test/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("i'm alive :D ");
  });

  it("GET /api/strava/event echoes the challenge when verify token matches", async () => {
    const token = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
    const url = `http://test/api/strava/event?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`;
    const res = await app.fetch(new Request(url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "hub.challenge": "abc123" });
  });

  it("GET /api/strava/event rejects bad verify token", async () => {
    const url =
      "http://test/api/strava/event?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc";
    const res = await app.fetch(new Request(url));
    expect(res.status).toBe(403);
  });

  it("POST /api/strava/event rejects bad subscription_id", async () => {
    const res = await app.fetch(
      new Request("http://test/api/strava/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          object_type: "activity",
          object_id: 1,
          aspect_type: "create",
          owner_id: 2,
          subscription_id: 1, // doesn't match STRAVA_SUBSCRIPTION_ID
          event_time: 1234,
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ status: "unauthorized" });
  });

  it("POST /api/strava/event accepts matching subscription_id", async () => {
    const subId = Number(process.env.STRAVA_SUBSCRIPTION_ID);
    const res = await app.fetch(
      new Request("http://test/api/strava/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          object_type: "activity",
          object_id: 1,
          aspect_type: "create",
          owner_id: 2,
          subscription_id: subId,
          event_time: 1234,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("POST /api/intervals/event rejects bad secret", async () => {
    const res = await app.fetch(
      new Request("http://test/api/intervals/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: "wrong",
          events: [{ type: "TEST", athlete_id: "i1" }],
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/intervals/event accepts matching secret", async () => {
    const res = await app.fetch(
      new Request("http://test/api/intervals/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.INTERVALS_WEBHOOK_SECRET,
          events: [{ type: "TEST", athlete_id: "i1" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/privacy-policy returns markdown", async () => {
    const res = await app.fetch(new Request("http://test/api/privacy-policy"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("GET /api/terms-of-service returns markdown", async () => {
    const res = await app.fetch(new Request("http://test/api/terms-of-service"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
  });
});

describe("auth gate", () => {
  it("authenticated routes refuse to run without a test identity", async () => {
    // No withIdentity() wrapper → testAuthGuard returns 401.
    const res = await app.fetch(new Request("http://test/api/v1/user"));
    expect(res.status).toBe(401);
  });
});
