import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { clientKeyGuard } from "../src/middlewares/client_key_middleware";
import { AppError } from "../src/error";
import { logger } from "../src/logger";

const KEY = "test-client-key-abcdef123456";

// Mirrors src/index.ts mount order: a public route registered BEFORE the guard,
// the guard on /api/*, then a protected route after it.
function makeApp(opts: { key?: string; mode: "log" | "enforce" }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", logger);
    await next();
  });
  app.get("/api/health", (c) => c.json("ok"));
  app.use("/api/*", clientKeyGuard(opts));
  app.get("/api/secret", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message }, err.status as 401);
    return c.json({ error: "boom" }, 500);
  });
  return app;
}

const get = (app: Hono, path: string, key?: string) =>
  app.fetch(new Request(`http://t${path}`, { headers: key ? { "x-client-key": key } : {} }));

describe("clientKeyGuard — key unset (feature off)", () => {
  it("lets every request through", async () => {
    const app = makeApp({ key: undefined, mode: "enforce" });
    expect((await get(app, "/api/secret")).status).toBe(200);
  });
});

describe("clientKeyGuard — log mode", () => {
  it("passes with the right key", async () => {
    const app = makeApp({ key: KEY, mode: "log" });
    expect((await get(app, "/api/secret", KEY)).status).toBe(200);
  });
  it("passes (does not block) with a wrong/missing key", async () => {
    const app = makeApp({ key: KEY, mode: "log" });
    expect((await get(app, "/api/secret", "wrong")).status).toBe(200);
    expect((await get(app, "/api/secret")).status).toBe(200);
  });
});

describe("clientKeyGuard — enforce mode", () => {
  it("401s on missing or wrong key with the {error} envelope", async () => {
    const app = makeApp({ key: KEY, mode: "enforce" });
    const missing = await get(app, "/api/secret");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    expect((await get(app, "/api/secret", "wrong")).status).toBe(401);
  });
  it("passes with the right key", async () => {
    const app = makeApp({ key: KEY, mode: "enforce" });
    expect((await get(app, "/api/secret", KEY)).status).toBe(200);
  });
  it("exempts public routes registered before the guard (mount-order invariant)", async () => {
    const app = makeApp({ key: KEY, mode: "enforce" });
    // No key, yet /api/health stays open because its handler terminates the
    // chain before the later-registered guard — the whole Tier 2 exemption story.
    expect((await get(app, "/api/health")).status).toBe(200);
  });
});
