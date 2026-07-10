import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registry, runTool } from "../src/agent/training/tool_registry";
import { type CoachCtx, isToolAvailable } from "../src/agent/training/tool_types";
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

  it("exposes activity-source tools for an intervals-only user", () => {
    const tools = selectMcpTools({ stravaLinked: false, intervalsConnected: true });
    expect(tools.some((t) => t.name === "get_activity_streams_summary")).toBe(true);
  });

  it("exposes activity-source tools for a strava-only user", () => {
    const tools = selectMcpTools({ stravaLinked: true, intervalsConnected: false });
    expect(tools.some((t) => t.name === "get_activity_streams_summary")).toBe(true);
  });
});

describe("isToolAvailable", () => {
  const streamsTool = registry.find((t) => t.name === "get_activity_streams_summary");

  it("exposes get_activity_streams_summary for an intervals-only user", () => {
    expect(streamsTool?.requires).toBe("activity-source");
    expect(isToolAvailable(streamsTool!, ctxFor({ intervalsConnected: true, stravaLinked: false })))
      .toBe(true);
  });

  it("hides get_activity_streams_summary when neither source is linked", () => {
    expect(
      isToolAvailable(streamsTool!, ctxFor({ intervalsConnected: false, stravaLinked: false })),
    ).toBe(false);
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
