import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import * as intakeAgent from "../src/agent/planning/intake/intake_agent";
import {
  __peekQuota,
  __resetQuotaStore,
  PLAN_INTAKE_QUOTA,
} from "../src/middlewares/quota_middleware";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

// Endpoint suite for the pre-plan intake chat. The single LLM seam
// (invokeIntakeModel) is scripted — no live OpenAI calls.

const app = buildTestApp(getPool());

let premium: { id: string; email: string };
let other: { id: string; email: string };
let guest: { id: string; email: string };

const asPremium = () => ({
  userId: premium.id,
  role: "premium" as const,
});
const asOther = () => ({ userId: other.id, role: "premium" as const });
const asGuest = () => ({ userId: guest.id, role: "guest" as const });

let callId = 0;
const aiToolCall = (name: string, args: Record<string, unknown>) =>
  new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `call_${++callId}`, type: "tool_call" }],
  });
const aiText = (text: string) => new AIMessage({ content: text });

let script: AIMessage[] = [];
let modelSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  premium = await createTestUser({ role: "premium" });
  other = await createTestUser({ role: "premium" });
  guest = await createTestUser({ role: "guest" });
  modelSpy = spyOn(intakeAgent, "invokeIntakeModel").mockImplementation(async () => {
    const next = script.shift();
    if (!next) throw new Error("intake model script exhausted");
    return next;
  });
});

afterAll(async () => {
  modelSpy.mockRestore();
  await deleteTestUser(premium.id);
  await deleteTestUser(other.id);
  await deleteTestUser(guest.id);
  await closePool();
});

afterEach(() => {
  __resetQuotaStore();
});

function postIntake(body: unknown) {
  return app.fetch(
    new Request("http://test/api/v1/training-plans/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function deleteIntake(threadId: string) {
  return app.fetch(
    new Request(`http://test/api/v1/training-plans/intake/${threadId}`, { method: "DELETE" }),
  );
}

type TurnResponse = {
  threadId: string;
  reply: string;
  draft: Record<string, unknown>;
  ready: boolean;
  brief?: string;
};

describe("POST /api/v1/training-plans/intake", () => {
  it("starts a new thread, saves draft fields, and accumulates across turns to finalize", async () => {
    script = [
      aiToolCall("update_plan_draft", { goalText: "sub-20 5k", daysPerWeek: 4 }),
      aiText("Got it — when would you like to start?"),
    ];
    const first = await withIdentity(asPremium(), () =>
      postIntake({ message: "I want a sub-20 5k, I can run 4 days a week" }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TurnResponse;
    expect(firstBody.threadId).toMatch(/^plan-intake:[0-9a-f-]{36}$/);
    expect(firstBody.reply).toBe("Got it — when would you like to start?");
    expect(firstBody.draft).toEqual({ goalText: "sub-20 5k", daysPerWeek: 4 });
    expect(firstBody.ready).toBe(false);
    expect(firstBody.brief).toBeUndefined();
    expect(__peekQuota(PLAN_INTAKE_QUOTA, premium.id)).toBe(1);

    const brief = "No injuries; prefers threshold sessions; motivated by a parkrun PB.";
    script = [
      aiToolCall("update_plan_draft", { startDate: "2026-08-03", endDate: "2026-09-27" }),
      aiToolCall("finalize_intake", { athleteBrief: brief }),
      aiText("All set — review the settings and start the plan builder."),
    ];
    const second = await withIdentity(asPremium(), () =>
      postIntake({ threadId: firstBody.threadId, message: "Start in August, 8 weeks" }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as TurnResponse;
    expect(secondBody.threadId).toBe(firstBody.threadId);
    expect(secondBody.draft).toEqual({
      goalText: "sub-20 5k",
      daysPerWeek: 4,
      startDate: "2026-08-03",
      endDate: "2026-09-27",
    });
    expect(secondBody.ready).toBe(true);
    expect(secondBody.brief).toBe(brief);

    await withIdentity(asPremium(), () => deleteIntake(firstBody.threadId));
  });

  it("404s a turn on a thread owned by another user — same body as an unknown thread", async () => {
    script = [aiText("Hi! What are you training for?")];
    const res = await withIdentity(asPremium(), () => postIntake({ message: "hello" }));
    const { threadId } = (await res.json()) as TurnResponse;

    const foreign = await withIdentity(asOther(), () => postIntake({ threadId, message: "hi" }));
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({
      error: expect.stringContaining("No intake conversation"),
    });

    const unknown = await withIdentity(asOther(), () =>
      postIntake({
        threadId: "plan-intake:ffffffff-ffff-ffff-ffff-ffffffffffff",
        message: "hi",
      }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: expect.stringContaining("No intake conversation"),
    });

    await withIdentity(asPremium(), () => deleteIntake(threadId));
  });

  it("403s a guest — the intake sits behind the training-plans premium gate", async () => {
    const post = await withIdentity(asGuest(), () => postIntake({ message: "hello" }));
    expect(post.status).toBe(403);

    const del = await withIdentity(asGuest(), () =>
      deleteIntake("plan-intake:ffffffff-ffff-ffff-ffff-ffffffffffff"),
    );
    expect(del.status).toBe(403);
  });

  it("400s an empty or oversized message", async () => {
    const empty = await withIdentity(asPremium(), () => postIntake({ message: "" }));
    expect(empty.status).toBe(400);

    const oversized = await withIdentity(asPremium(), () =>
      postIntake({ message: "x".repeat(2001) }),
    );
    expect(oversized.status).toBe(400);
  });
});

describe("DELETE /api/v1/training-plans/intake/:threadId", () => {
  it("resets an owned thread; a later turn on it 404s", async () => {
    script = [aiText("Hi! What are you training for?")];
    const res = await withIdentity(asPremium(), () => postIntake({ message: "hello" }));
    const { threadId } = (await res.json()) as TurnResponse;

    const del = await withIdentity(asPremium(), () => deleteIntake(threadId));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const after = await withIdentity(asPremium(), () => postIntake({ threadId, message: "hi" }));
    expect(after.status).toBe(404);
  });

  it("404s deleting a foreign or unknown thread", async () => {
    script = [aiText("Hi!")];
    const res = await withIdentity(asPremium(), () => postIntake({ message: "hello" }));
    const { threadId } = (await res.json()) as TurnResponse;

    const foreign = await withIdentity(asOther(), () => deleteIntake(threadId));
    expect(foreign.status).toBe(404);

    const unknown = await withIdentity(asPremium(), () =>
      deleteIntake("plan-intake:ffffffff-ffff-ffff-ffff-ffffffffffff"),
    );
    expect(unknown.status).toBe(404);

    await withIdentity(asPremium(), () => deleteIntake(threadId));
  });
});
