import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, intervalStructures } from "../src/schema";
import { anchorSecPerKmForStep, fillPacesFromAnchor } from "../src/services/pace_anchor_service";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { WorkoutStructureSet } from "../src/schemas/agent_schemas";
import { toISODate } from "../src/services/utils";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import {
  insertActivity,
  insertIntervalStructure,
  insertPlannedSession,
  insertTrainingPlan,
  insertTrainingPlanWeek,
} from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { suggestSessionAgentMock } from "./setup";

const app = buildTestApp(getPool());

let planUser: { id: string; clerkId: string };
let plainUser: { id: string; clerkId: string };
// Same active plan as planUser, but the role was downgraded (lapsed subscription).
let downgradedUser: { id: string; clerkId: string };

const structure: WorkoutStructureSet[] = [
  {
    set_reps: 1,
    set_recovery: null,
    steps: [
      {
        reps: 5,
        work_type: "DISTANCE",
        work_value: 1000,
        recovery_type: "TIME",
        recovery_value: 90,
        target_pace: null,
      },
    ],
  },
];

const today = toISODate(new Date());

beforeAll(async () => {
  planUser = await createTestUser({ role: "premium", intervals: false });
  plainUser = await createTestUser({ role: "premium", intervals: false });
  downgradedUser = await createTestUser({ role: "guest", intervals: false });

  for (const owner of [planUser, downgradedUser]) {
    const plan = await insertTrainingPlan(owner.id, { status: "active" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    await insertPlannedSession(plan.id, week.id, {
      date: today,
      sessionType: "LONG_INTERVALS",
      title: "5x1000m threshold",
      description: "Key session for the week",
      structure,
      sortOrder: 0,
    });
  }
});

afterAll(async () => {
  await deleteTestUser(planUser.id);
  await deleteTestUser(plainUser.id);
  await deleteTestUser(downgradedUser.id);
  await closePool();
});

beforeEach(() => suggestSessionAgentMock.reset());

const planIdentity = () => ({
  userId: planUser.id,
  clerkUserId: planUser.clerkId,
  role: "premium" as const,
});
const plainIdentity = () => ({
  userId: plainUser.id,
  clerkUserId: plainUser.clerkId,
  role: "premium" as const,
});

const downgradedIdentity = () => ({
  userId: downgradedUser.id,
  clerkUserId: downgradedUser.clerkId,
  role: "guest" as const,
});

function post(body: unknown) {
  return app.fetch(
    new Request("http://test/api/v1/agents/suggest-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("anchor pace filling (plan mode waterfall)", () => {
  const paces = {
    easySecPerKm: 300,
    thresholdSecPerKm: 240,
    intervalSecPerKm: 220,
    repSecPerKm: 200,
  };

  it("classifies steps by session type and rep size", () => {
    expect(anchorSecPerKmForStep({ work_type: "DISTANCE", work_value: 400 }, "SHORT_INTERVALS", paces)).toBe(200);
    expect(anchorSecPerKmForStep({ work_type: "DISTANCE", work_value: 1000 }, "LONG_INTERVALS", paces)).toBe(220);
    expect(anchorSecPerKmForStep({ work_type: "DISTANCE", work_value: 5000 }, "TEMPO", paces)).toBe(240);
    expect(anchorSecPerKmForStep({ work_type: "DISTANCE", work_value: 8000 }, "EASY", paces)).toBe(300);
  });

  it("fills only unpaced steps, leaving existing paces untouched", () => {
    const sets: ExpandedIntervalSet[] = [
      {
        set_recovery: null,
        steps: [
          { work_type: "DISTANCE", work_value: 1000, target_pace: null },
          { work_type: "DISTANCE", work_value: 1000, target_pace: 3.5 },
        ],
      },
    ];
    const filled = fillPacesFromAnchor(sets, paces, "LONG_INTERVALS");
    expect(filled[0].steps[0].target_pace).toBeCloseTo(1000 / 220, 5);
    expect(filled[0].steps[1].target_pace).toBe(3.5);
  });
});

describe("POST /api/v1/agents/suggest-session — plan mode (D8)", () => {
  it("auto-resolves to plan mode when a session is due today, without an LLM call", async () => {
    const res = await withIdentity(planIdentity(), () => post({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("plan");
    expect(body.plannedSessionId).toBeGreaterThan(0);
    expect(body.planId).toBeGreaterThan(0);
    expect(body.proposedTraining.title).toBe("5x1000m threshold");
    expect(body.proposedTraining.structure[0].steps[0].work_value).toBe(1000);
    expect(suggestSessionAgentMock.calls).toBe(0);
  });

  it("leaves the legacy path untouched when the user has no active plan", async () => {
    const res = await withIdentity(plainIdentity(), () => post({ structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("signature");
    expect(body.plannedSessionId ?? null).toBe(null);
    expect(suggestSessionAgentMock.calls).toBeGreaterThan(0);
  });

  it("explicit ai mode skips plan mode even when a session is due", async () => {
    const res = await withIdentity(planIdentity(), () => post({ mode: "ai", structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("ai");
    expect(body.plannedSessionId ?? null).toBe(null);
    expect(suggestSessionAgentMock.calls).toBeGreaterThan(0);
  });

  // An inline structure is as signature-shaped as a structureId — auto must not
  // hijack it onto the due planned session.
  it("an inline structure with no mode stays on the signature path when a plan session is due", async () => {
    const res = await withIdentity(planIdentity(), () => post({ structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("signature");
    expect(body.plannedSessionId ?? null).toBe(null);
  });

  // Pre-rename wire value from installed app builds; the backend may deploy first.
  it("accepts legacy mode 'recommended' as 'ai'", async () => {
    const res = await withIdentity(planIdentity(), () => post({ mode: "recommended", structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("ai");
  });

  it("explicit plan mode with nothing due 404s", async () => {
    const res = await withIdentity(plainIdentity(), () => post({ mode: "plan" }));
    expect(res.status).toBe(404);
    expect(suggestSessionAgentMock.calls).toBe(0);
  });

  // Training plans are premium in whole, so this deliberately-free endpoint must
  // not stay a working plan-read path for a downgraded user.
  it("does not serve a due plan session to a non-premium user under auto", async () => {
    const res = await withIdentity(downgradedIdentity(), () => post({ structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Falls through to the free signature path rather than erroring.
    expect(body.mode).toBe("signature");
    expect(body.plannedSessionId ?? null).toBe(null);
    expect(body.planId ?? null).toBe(null);
  });

  it("404s a non-premium user's explicit plan mode as if nothing were due", async () => {
    const res = await withIdentity(downgradedIdentity(), () => post({ mode: "plan" }));
    expect(res.status).toBe(404);
    expect(suggestSessionAgentMock.calls).toBe(0);
  });

  it("still serves the same due session to a premium user (the gate is role, not data)", async () => {
    const res = await withIdentity(planIdentity(), () => post({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("plan");
    expect(body.planId).toBeGreaterThan(0);
  });

  it("leaves the free signature/ai modes untouched for a non-premium user", async () => {
    const res = await withIdentity(downgradedIdentity(), () => post({ mode: "ai", structure }));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("ai");
  });

  it("keys the cache by resolved mode so 'suggest another' (ai) doesn't collide with a plan suggestion", async () => {
    const planRes = await withIdentity(planIdentity(), () => post({}));
    expect((await planRes.json()).mode).toBe("plan");

    const aiRes = await withIdentity(planIdentity(), () => post({ mode: "ai", structure }));
    const aiBody = await aiRes.json();
    expect(aiBody.mode).toBe("ai");
    expect(aiBody.plannedSessionId ?? null).toBe(null);
  });
});

// The due planned session here is an UNSTRUCTURED easy run — the case that used
// to hijack an explicit structureId request into the plan path and 422.
describe("POST /api/v1/agents/suggest-session — unstructured due session routing", () => {
  let owner: { id: string; clerkId: string };
  let structureId: number;

  const ownerIdentity = () => ({
    userId: owner.id,
    clerkUserId: owner.clerkId,
    role: "premium" as const,
  });

  beforeAll(async () => {
    owner = await createTestUser({ role: "premium", intervals: false });

    const plan = await insertTrainingPlan(owner.id, { status: "active" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    await insertPlannedSession(plan.id, week.id, {
      date: today,
      sessionType: "EASY",
      title: "Easy run",
      structure: null,
      sortOrder: 0,
    });

    const stored = await insertIntervalStructure({ name: "5x1000m" });
    structureId = stored.id;
    const activity = await insertActivity(owner.id, {
      trainingType: "LONG_INTERVALS",
      intervalStructureId: structureId,
    });
    await getDb()
      .update(activities)
      .set({ draftAnalysisResult: { structure } })
      .where(eq(activities.id, activity.id));
  });

  afterAll(async () => {
    await deleteTestUser(owner.id);
    await getDb().delete(intervalStructures).where(eq(intervalStructures.id, structureId));
  });

  it("an explicit structureId wins over the due plan session under auto", async () => {
    const res = await withIdentity(ownerIdentity(), () => post({ structureId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("signature");
    expect(body.plannedSessionId ?? null).toBe(null);
    expect(body.planId ?? null).toBe(null);
    expect(suggestSessionAgentMock.calls).toBeGreaterThan(0);
  });

  it("auto with no structureId falls back to signature when the due session has no structure", async () => {
    const res = await withIdentity(ownerIdentity(), () => post({ structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("signature");
    expect(body.plannedSessionId ?? null).toBe(null);
  });

  it("explicit plan mode on an unstructured due session still 422s", async () => {
    const res = await withIdentity(ownerIdentity(), () => post({ mode: "plan" }));
    expect(res.status).toBe(422);
    expect(suggestSessionAgentMock.calls).toBe(0);
  });
});
