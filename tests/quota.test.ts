import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../src/error";
import { logger } from "../src/logger";
import {
  __peekQuota,
  __resetQuotaStore,
  __setClock,
  consumeQuota,
  dailyQuota,
  tryConsumeQuota,
} from "../src/middlewares/quota_middleware";

// Tiny app exercising the real middleware with an injected low max. `x-user`
// sets the resolved userId, standing in for authGuard.
function makeApp(name: string, max: number) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-user") ?? "");
    c.set("logger", logger);
    await next();
  });
  app.post("/q", dailyQuota(name, max), (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message }, err.status as 429);
    return c.json({ error: "boom" }, 500);
  });
  return app;
}

const post = (app: Hono, user: string) =>
  app.fetch(new Request("http://t/q", { method: "POST", headers: { "x-user": user } }));

afterEach(() => {
  __resetQuotaStore();
  __setClock(null);
});

describe("dailyQuota middleware", () => {
  it("passes up to the cap, then 429s with the {error} envelope", async () => {
    const app = makeApp("mw", 2);
    expect((await post(app, "u1")).status).toBe(200);
    expect((await post(app, "u1")).status).toBe(200);
    const res = await post(app, "u1");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: expect.stringContaining("Daily limit") });
  });

  it("isolates counts per user", async () => {
    const app = makeApp("mw", 1);
    expect((await post(app, "a")).status).toBe(200);
    expect((await post(app, "a")).status).toBe(429);
    // b has its own bucket
    expect((await post(app, "b")).status).toBe(200);
  });
});

describe("quota day rollover", () => {
  it("resets the counter when the UTC day changes", () => {
    __setClock(() => new Date("2026-07-08T23:59:00Z"));
    consumeQuota("roll", 5, "u");
    consumeQuota("roll", 5, "u");
    expect(__peekQuota("roll", "u")).toBe(2);

    __setClock(() => new Date("2026-07-09T00:01:00Z"));
    consumeQuota("roll", 5, "u");
    expect(__peekQuota("roll", "u")).toBe(1);
  });
});

describe("consumeQuota / tryConsumeQuota", () => {
  it("consumeQuota throws AppError(429) once over cap", () => {
    consumeQuota("c", 1, "u");
    expect(() => consumeQuota("c", 1, "u")).toThrow(AppError);
    try {
      consumeQuota("c", 1, "u");
    } catch (err) {
      expect((err as AppError).status).toBe(429);
    }
  });

  it("tryConsumeQuota counts N and trips (returns false) past the cap", () => {
    // Mirrors an import fan-out: N ids ⇒ N increments, one request.
    const N = 4;
    for (let i = 0; i < N; i++) {
      expect(tryConsumeQuota("import", N, "u")).toBe(true);
    }
    expect(__peekQuota("import", "u")).toBe(N);
    // The (N+1)-th start is the circuit breaker tripping.
    expect(tryConsumeQuota("import", N, "u")).toBe(false);
  });
});
