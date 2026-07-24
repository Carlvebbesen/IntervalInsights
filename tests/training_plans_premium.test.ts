import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registry } from "../src/agent/training/tool_registry";
import { selectMcpTools } from "../src/mcp/server";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

// The whole training-plan feature is premium-only, like coach chat. Three
// surfaces reach the same controllers — REST plan routes, the plan-builder
// wizard, and MCP — and all three must be gated.

const app = buildTestApp(getPool());

let guest: { id: string; email: string };
let premium: { id: string; email: string };

beforeAll(async () => {
  guest = await createTestUser({ role: "guest" });
  premium = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(guest.id);
  await deleteTestUser(premium.id);
  await closePool();
});

const asGuest = () => ({ userId: guest.id, role: "guest" as const });
const asPremium = () => ({
  userId: premium.id,
  role: "premium" as const,
});

const GET_ROUTES = ["/api/v1/training-plans", "/api/v1/race-events"];

const POST_ROUTES: [string, unknown][] = [
  [
    "/api/v1/training-plans/generate",
    { startDate: "2026-01-05", endDate: "2026-01-25", daysPerWeek: 4 },
  ],
  [
    "/api/v1/training-plans/generate/resume",
    { threadId: "plan-builder:nope", action: "accept" },
  ],
  ["/api/v1/race-events", { name: "Spring 10k", date: "2026-04-04", distanceMeters: 10000 }],
];

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("training-plan routes are premium-only", () => {
  it("403s a guest on every plan read route", async () => {
    for (const path of GET_ROUTES) {
      const res = await withIdentity(asGuest(), () =>
        app.fetch(new Request(`http://test${path}`)),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("403s a guest on the plan-builder wizard and plan writes", async () => {
    for (const [path, body] of POST_ROUTES) {
      const res = await withIdentity(asGuest(), () => post(path, body));
      expect(res.status).toBe(403);
    }
  });

  it("lets a premium user through the same gate", async () => {
    for (const path of GET_ROUTES) {
      const res = await withIdentity(asPremium(), () =>
        app.fetch(new Request(`http://test${path}`)),
      );
      expect(res.status).toBe(200);
    }
  });
});

describe("MCP inherits the premium gate", () => {
  const planToolNames = registry.filter((t) => t.premium).map((t) => t.name);

  it("marks the whole training-plan tool family premium", () => {
    expect(planToolNames).toContain("create_training_plan");
    expect(planToolNames).toContain("add_planned_session");
    expect(planToolNames).toContain("apply_plan_revision");
    expect(planToolNames).toContain("create_race_event");
    expect(planToolNames).toContain("list_training_plans");
  });

  it("hides every premium tool from a non-premium MCP client", () => {
    const tools = selectMcpTools({
      stravaLinked: true,
      intervalsConnected: true,
      premium: false,
    }).map((t) => t.name);

    for (const name of planToolNames) expect(tools).not.toContain(name);
    // Non-premium tools are untouched — the gate is scoped, not a kill switch.
    expect(tools).toContain("list_activities");
  });

  it("exposes them again for a premium MCP client", () => {
    const tools = selectMcpTools({
      stravaLinked: true,
      intervalsConnected: true,
      premium: true,
    }).map((t) => t.name);

    for (const name of planToolNames) expect(tools).toContain(name);
  });
});
