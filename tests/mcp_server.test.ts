import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { runTool } from "../src/agent/training/tool_registry";
import type { CoachCtx } from "../src/agent/training/tool_types";
import { logger } from "../src/logger";
import { buildMcpServer, selectMcpTools } from "../src/mcp/server";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

const db = getDb();
let user: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

function ctxFor(overrides?: Partial<CoachCtx>): CoachCtx {
  return {
    db,
    userId: user.id,
    clerkUserId: user.clerkId,
    stravaAccessToken: "test-token",
    intervalsConnected: false,
    userTime: new Date().toISOString(),
    logger,
    ...overrides,
  };
}

describe("selectMcpTools", () => {
  it("exposes only db-backed tools when nothing is connected", () => {
    const tools = selectMcpTools({ stravaLinked: false, intervalsConnected: false });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.requires === "db")).toBe(true);
  });

  it("unlocks strava and intervals tools once connected", () => {
    const tools = selectMcpTools({ stravaLinked: true, intervalsConnected: true });
    expect(tools.some((t) => t.requires === "strava")).toBe(true);
    expect(tools.some((t) => t.requires === "intervals")).toBe(true);
  });

  it("excludes tools that make their own OpenAI calls, keeping pure-db siblings", () => {
    const tools = selectMcpTools({ stravaLinked: true, intervalsConnected: true });
    expect(tools.some((t) => t.name === "parse_workout")).toBe(false);
    expect(tools.some((t) => t.name === "propose_paces")).toBe(true);
  });
});

describe("buildMcpServer", () => {
  it("registers every selected tool without name collisions", () => {
    const tools = selectMcpTools({ stravaLinked: true, intervalsConnected: true });
    expect(() => buildMcpServer(ctxFor(), tools)).not.toThrow();
  });
});

describe("read-only tool execution over MCP context", () => {
  it("runs get_athlete_profile against the real db", async () => {
    const result = await runTool("get_athlete_profile", {}, ctxFor());
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      stravaConnected: false,
      intervalsConnected: false,
    });
  });
});
