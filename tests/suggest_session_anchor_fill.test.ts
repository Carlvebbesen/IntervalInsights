import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { WorkoutStructureSet } from "../src/schemas/agent_schemas";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";
import { suggestSessionAgentMock } from "./setup";

const app = buildTestApp(getPool());

let anchoredUser: { id: string; email: string };

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

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

beforeAll(async () => {
  anchoredUser = await createTestUser({ role: "premium", intervals: false });

  // Two RACE efforts in different duration buckets (bucketForDuration picks the
  // nearest of [120,180,300,600,900,1200]) so bestEffortsPerBucket keeps both,
  // clearing MIN_STORED_EFFORTS (2) and giving fetchPaceAnchor a real anchor —
  // with no rep-signature history (pace_service is globally stubbed to `[]`).
  await insertActivity(anchoredUser.id, {
    trainingType: "RACE",
    distance: 1000,
    movingTime: 200,
    startDateLocal: daysAgo(30),
  });
  await insertActivity(anchoredUser.id, {
    trainingType: "RACE",
    distance: 3200,
    movingTime: 800,
    startDateLocal: daysAgo(10),
  });
});

afterAll(async () => {
  await deleteTestUser(anchoredUser.id);
  await closePool();
});

beforeEach(() => suggestSessionAgentMock.reset());

const identity = () => ({
  userId: anchoredUser.id,
  role: "premium" as const,
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

describe("POST /api/v1/agents/suggest-session — signature mode anchor-fill", () => {
  it("fills target paces from the pace anchor when there is no rep-signature history", async () => {
    const res = await withIdentity(identity(), () => post({ mode: "signature", structure }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("signature");

    const paces = body.proposedTraining.structure.flatMap((set: { steps: { target_pace: number | null }[] }) =>
      set.steps.map((step) => step.target_pace),
    );
    expect(paces.length).toBeGreaterThan(0);
    for (const pace of paces) {
      expect(pace).not.toBeNull();
      expect(pace).toBeGreaterThan(0);
    }
  });
});
