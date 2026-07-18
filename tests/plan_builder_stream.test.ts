import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as macroAgent from "../src/agent/planning/plan_macro_agent";
import type { GenerateSessionsOutput, PlanMacro } from "../src/agent/planning/plan_builder_schemas";
import * as sessionsAgent from "../src/agent/planning/plan_sessions_agent";
import {
  __peekQuota,
  __resetQuotaStore,
  PLAN_BUILDER_QUOTA,
} from "../src/middlewares/quota_middleware";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let userA: { id: string; clerkId: string };
let userB: { id: string; clerkId: string };

const identityA = () => ({ userId: userA.id, clerkUserId: userA.clerkId, role: "premium" as const });
const identityB = () => ({ userId: userB.id, clerkUserId: userB.clerkId, role: "premium" as const });

const rawMacro = (): PlanMacro => ({
  name: "Stub 5k Plan",
  rationale: "progressive base into a sharpening block",
  weeks: [
    {
      weekIndex: 1,
      startDate: "ignored",
      phase: "base",
      targetDistanceMeters: 30000,
      keySessions: ["5x1000m"],
    },
    {
      weekIndex: 2,
      startDate: "ignored",
      phase: "build",
      targetDistanceMeters: 34000,
      keySessions: ["Tempo 20min"],
    },
  ],
});

const sessionsOutput = (): GenerateSessionsOutput => ({
  weeks: [1, 2].map((weekIndex) => ({
    weekIndex,
    sessions: [
      { date: "2026-01-06", sessionType: "EASY", title: "Easy run", structure: null },
      { date: "2026-01-08", sessionType: "EASY", title: "Easy run 2", structure: null },
    ],
  })),
});

const spies: { mockRestore: () => void }[] = [];
let macroSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  userA = await createTestUser({ role: "premium" });
  userB = await createTestUser({ role: "premium" });

  macroSpy = spyOn(macroAgent, "invokeProposeMacroAgent").mockResolvedValue(rawMacro());
  spies.push(macroSpy);
  spies.push(
    spyOn(sessionsAgent, "invokeGenerateSessionsAgent").mockResolvedValue(sessionsOutput()),
  );
});

afterAll(async () => {
  for (const s of spies) s.mockRestore();
  await deleteTestUser(userA.id);
  await deleteTestUser(userB.id);
  await closePool();
});

afterEach(() => {
  __resetQuotaStore();
});

/** Reads SSE frames from a byte-stream reader, skipping heartbeat pings. */
function frameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";

  async function readOne(timeoutMs: number): Promise<{ event: string; data: string }> {
    while (true) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
        }
        return { event, data: dataLines.join("\n") };
      }
      const chunk = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs);
        reader.read().then(
          (r) => {
            clearTimeout(t);
            resolve(r);
          },
          (e) => {
            clearTimeout(t);
            reject(e);
          },
        );
      });
      if (chunk.done) throw new Error("stream ended before a full frame");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return async function next(timeoutMs = 10000) {
    while (true) {
      const frame = await readOne(timeoutMs);
      if (frame.event === "ping") continue;
      return frame;
    }
  };
}

async function readUntilTerminal(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = frameReader(reader);
  const seen: { event: string; data: string }[] = [];
  while (true) {
    const frame = await next();
    seen.push(frame);
    if (frame.event === "interrupt" || frame.event === "done" || frame.event === "error") {
      return { terminal: frame, seen };
    }
  }
}

function postJson(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function startWizard(identity: { userId: string; clerkUserId: string; role: "premium" }) {
  return withIdentity(identity, async () => {
    const res = await postJson("/api/v1/training-plans/generate", {
      name: "My 5k plan",
      startDate: "2026-01-05",
      endDate: "2026-01-18",
      goalText: "sub-20 5k",
    });
    expect(res.status).toBe(200);
    if (!res.body) throw new Error("expected a streaming body");
    const reader = res.body.getReader();
    const next = frameReader(reader);

    const started = await next();
    expect(started.event).toBe("started");
    const { threadId } = JSON.parse(started.data) as { threadId: string };

    const { terminal } = await readUntilTerminal(reader);
    await reader.cancel();
    return { threadId, terminal };
  });
}

async function resumeWizard(
  identity: { userId: string; clerkUserId: string; role: "premium" },
  threadId: string,
  resume: { action: "accept" } | { action: "adjust"; feedback: string },
) {
  return withIdentity(identity, async () => {
    const res = await postJson("/api/v1/training-plans/generate/resume", {
      threadId,
      ...resume,
    });
    return res;
  });
}

describe("POST /api/v1/training-plans/generate + /generate/resume", () => {
  it("runs the full wizard over HTTP to a persisted active plan", async () => {
    const callsBefore = macroSpy.mock.calls.length;

    const { threadId, terminal: firstInterrupt } = await startWizard(identityA());
    expect(firstInterrupt.event).toBe("interrupt");
    const firstPayload = JSON.parse(firstInterrupt.data) as { phase: string; threadId: string };
    expect(firstPayload.phase).toBe("macro_review");
    expect(firstPayload.threadId).toBe(threadId);

    const adjustRes = await resumeWizard(identityA(), threadId, {
      action: "adjust",
      feedback: "add more mileage",
    });
    expect(adjustRes.status).toBe(200);
    if (!adjustRes.body) throw new Error("expected a streaming body");
    const adjustReader = adjustRes.body.getReader();
    const { terminal: adjustTerminal } = await readUntilTerminal(adjustReader);
    await adjustReader.cancel();
    expect(adjustTerminal.event).toBe("interrupt");
    expect((JSON.parse(adjustTerminal.data) as { phase: string }).phase).toBe("macro_review");
    expect(macroSpy.mock.calls.length).toBe(callsBefore + 2);

    const acceptMacroRes = await resumeWizard(identityA(), threadId, { action: "accept" });
    expect(acceptMacroRes.status).toBe(200);
    if (!acceptMacroRes.body) throw new Error("expected a streaming body");
    const acceptMacroReader = acceptMacroRes.body.getReader();
    const { terminal: sessionsInterrupt } = await readUntilTerminal(acceptMacroReader);
    await acceptMacroReader.cancel();
    expect(sessionsInterrupt.event).toBe("interrupt");
    expect((JSON.parse(sessionsInterrupt.data) as { phase: string }).phase).toBe(
      "sessions_review",
    );

    const acceptSessionsRes = await resumeWizard(identityA(), threadId, { action: "accept" });
    expect(acceptSessionsRes.status).toBe(200);
    if (!acceptSessionsRes.body) throw new Error("expected a streaming body");
    const acceptSessionsReader = acceptSessionsRes.body.getReader();
    const { terminal: doneFrame } = await readUntilTerminal(acceptSessionsReader);
    await acceptSessionsReader.cancel();
    expect(doneFrame.event).toBe("done");
    const { planId } = JSON.parse(doneFrame.data) as { planId: number; threadId: string };
    expect(planId).toBeGreaterThan(0);

    const detailRes = await withIdentity(identityA(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${planId}`)),
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { status: string };
    expect(detail.status).toBe("active");
  });

  it("404s when another user tries to resume a thread they don't own, without opening an SSE stream", async () => {
    const { threadId, terminal } = await startWizard(identityA());
    expect(terminal.event).toBe("interrupt");

    const res = await withIdentity(identityB(), () =>
      postJson("/api/v1/training-plans/generate/resume", { threadId, action: "accept" }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    const body = await res.json();
    expect(body).toEqual({ error: expect.stringContaining("No pending plan-builder step") });
  });

  it("409s resuming a completed thread", async () => {
    const { threadId, terminal: firstInterrupt } = await startWizard(identityA());
    expect(firstInterrupt.event).toBe("interrupt");

    // Drive it to completion.
    let res = await resumeWizard(identityA(), threadId, { action: "accept" });
    if (!res.body) throw new Error("expected a streaming body");
    let reader = res.body.getReader();
    await readUntilTerminal(reader);
    await reader.cancel();

    res = await resumeWizard(identityA(), threadId, { action: "accept" });
    if (!res.body) throw new Error("expected a streaming body");
    reader = res.body.getReader();
    const { terminal: doneFrame } = await readUntilTerminal(reader);
    await reader.cancel();
    expect(doneFrame.event).toBe("done");

    const finalRes = await resumeWizard(identityA(), threadId, { action: "accept" });
    expect(finalRes.status).toBe(409);
    const body = await finalRes.json();
    expect(body).toEqual({ error: expect.stringContaining("No pending plan-builder step") });
  });

  it("400s an adjust resume with no feedback", async () => {
    const res = await withIdentity(identityA(), () =>
      postJson("/api/v1/training-plans/generate/resume", {
        threadId: "plan-builder:00000000-0000-0000-0000-000000000000",
        action: "adjust",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("mounts the daily plan-builder quota on both generate and generate/resume", async () => {
    __resetQuotaStore();
    await withIdentity(identityA(), () =>
      postJson("/api/v1/training-plans/generate", { startDate: "not-a-date", endDate: "2026-01-01" }),
    );
    expect(__peekQuota(PLAN_BUILDER_QUOTA, userA.id)).toBe(1);

    await withIdentity(identityA(), () =>
      postJson("/api/v1/training-plans/generate/resume", {
        threadId: "not-a-thread-id",
        action: "accept",
      }),
    );
    expect(__peekQuota(PLAN_BUILDER_QUOTA, userA.id)).toBe(2);
  });
});
