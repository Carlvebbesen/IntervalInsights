import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity, insertTrainingPlan } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let userA: { id: string; clerkId: string };
let userB: { id: string; clerkId: string };

beforeAll(async () => {
  userA = await createTestUser({ role: "premium" });
  userB = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(userA.id);
  await deleteTestUser(userB.id);
  await closePool();
});

const identityA = () => ({ userId: userA.id, clerkUserId: userA.clerkId, role: "premium" as const });
const identityB = () => ({ userId: userB.id, clerkUserId: userB.clerkId, role: "premium" as const });

const workoutStructure = [
  {
    set_reps: 3,
    set_recovery: 90,
    steps: [
      {
        reps: 1,
        work_type: "DISTANCE" as const,
        work_value: 1000,
        recovery_type: "TIME" as const,
        recovery_value: 60,
        target_pace: null,
      },
    ],
  },
];

async function createPlanWithChildren(identity: {
  userId: string;
  clerkUserId: string;
  role: "premium";
}) {
  return withIdentity(identity, async () => {
    const res = await app.fetch(
      new Request("http://test/api/v1/training-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Marathon Block",
          startDate: "2026-01-05",
          endDate: "2026-01-18",
          goalText: "Sub-4 marathon",
          weeks: [
            {
              weekIndex: 0,
              startDate: "2026-01-05",
              phase: "base",
              sessions: [
                { date: "2026-01-06", sessionType: "EASY", title: "Easy Run", sortOrder: 0 },
                {
                  date: "2026-01-08",
                  sessionType: "LONG_INTERVALS",
                  title: "Intervals",
                  sortOrder: 1,
                  structure: workoutStructure,
                },
              ],
            },
            {
              weekIndex: 1,
              startDate: "2026-01-12",
              phase: "build",
              sessions: [{ date: "2026-01-13", sessionType: "LONG", title: "Long Run", sortOrder: 0 }],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
    return res.json();
  });
}

describe("/api/v1/training-plans", () => {
  it("GET / only lists the requesting user's plans", async () => {
    const otherPlan = await insertTrainingPlan(userB.id, { name: "User B's plan" });

    await withIdentity(identityA(), async () => {
      await createPlanWithChildren(identityA());
      const res = await app.fetch(new Request("http://test/api/v1/training-plans"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.every((p: { name: string }) => p.name !== "User B's plan")).toBe(true);
    });

    await withIdentity(identityB(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/training-plans/${otherPlan.id}`),
      );
      expect(res.status).toBe(200);
    });

    await withIdentity(identityA(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/training-plans/${otherPlan.id}`),
      );
      expect(res.status).toBe(404);
    });
  });

  it("POST / creates a plan with nested weeks + sessions, and GET /:id returns the full tree", async () => {
    const created = await createPlanWithChildren(identityA());
    expect(created.name).toBe("Marathon Block");
    expect(created.weeks.length).toBe(2);
    expect(created.weeks[0].sessions.length).toBe(2);
    expect(created.weeks[1].sessions.length).toBe(1);
    expect(created.weeks[0].sessions[1].structure).toEqual(workoutStructure);

    const detailRes = await withIdentity(identityA(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${created.id}`)),
    );
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.id).toBe(created.id);
    expect(detail.weeks.length).toBe(2);
    expect(detail.weeks[0].weekIndex).toBe(0);
    expect(detail.weeks[1].weekIndex).toBe(1);
  });

  it("round-trips constraintsText through create, GET detail, and PATCH", async () => {
    const created = await withIdentity(identityA(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/training-plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Constrained Block",
            startDate: "2026-03-02",
            endDate: "2026-03-15",
            constraintsText: "Club long run every Saturday; no running Fridays",
          }),
        }),
      );
      expect(res.status).toBe(201);
      return res.json();
    });
    expect(created.constraintsText).toBe("Club long run every Saturday; no running Fridays");

    const detail = await withIdentity(identityA(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}`),
      );
      expect(res.status).toBe(200);
      return res.json();
    });
    expect(detail.constraintsText).toBe("Club long run every Saturday; no running Fridays");

    const patched = await withIdentity(identityA(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ constraintsText: "Track group Wednesday evenings" }),
        }),
      );
      expect(res.status).toBe(200);
      return res.json();
    });
    expect(patched.constraintsText).toBe("Track group Wednesday evenings");

    const cleared = await withIdentity(identityA(), async () => {
      const res = await app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ constraintsText: null }),
        }),
      );
      expect(res.status).toBe(200);
      return res.json();
    });
    expect(cleared.constraintsText).toBe(null);
  });

  it("PATCH /:id/sessions/:sessionId moves a session to another week, updating date and status", async () => {
    const created = await createPlanWithChildren(identityA());
    const week0 = created.weeks[0];
    const week1 = created.weeks[1];
    const session = week0.sessions[0];

    const res = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}/sessions/${session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: "2026-01-14", status: "skipped", weekId: week1.id }),
        }),
      ),
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.date).toBe("2026-01-14");
    expect(updated.status).toBe("skipped");
    expect(updated.weekId).toBe(week1.id);
  });

  it("links a session to an owned activity, rejects a second link, and unlink restores planned", async () => {
    const created = await createPlanWithChildren(identityA());
    const sessionOne = created.weeks[0].sessions[0];
    const sessionTwo = created.weeks[0].sessions[1];
    const activity = await insertActivity(userA.id, { title: "Completed Easy Run" });

    const linkRes = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(
          `http://test/api/v1/training-plans/${created.id}/sessions/${sessionOne.id}/link`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId: activity.id }),
          },
        ),
      ),
    );
    expect(linkRes.status).toBe(200);
    const linked = await linkRes.json();
    expect(linked.status).toBe("completed");
    expect(linked.completedActivityId).toBe(activity.id);

    const conflictRes = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(
          `http://test/api/v1/training-plans/${created.id}/sessions/${sessionTwo.id}/link`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId: activity.id }),
          },
        ),
      ),
    );
    expect(conflictRes.status).toBe(409);

    const unlinkRes = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(
          `http://test/api/v1/training-plans/${created.id}/sessions/${sessionOne.id}/link`,
          { method: "DELETE" },
        ),
      ),
    );
    expect(unlinkRes.status).toBe(200);
    const unlinked = await unlinkRes.json();
    expect(unlinked.status).toBe("planned");
    expect(unlinked.completedActivityId).toBe(null);
  });

  it("404s linking a session to another user's activity", async () => {
    const created = await createPlanWithChildren(identityA());
    const session = created.weeks[0].sessions[0];
    const othersActivity = await insertActivity(userB.id, { title: "Not yours" });

    const res = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(
          `http://test/api/v1/training-plans/${created.id}/sessions/${session.id}/link`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId: othersActivity.id }),
          },
        ),
      ),
    );
    expect(res.status).toBe(404);
  });

  it("404s linking a session through the wrong plan id (same user, different plan)", async () => {
    const planOne = await createPlanWithChildren(identityA());
    const planTwo = await createPlanWithChildren(identityA());
    const sessionInPlanOne = planOne.weeks[0].sessions[0];
    const activity = await insertActivity(userA.id, { title: "Cross-plan link attempt" });

    const res = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(
          `http://test/api/v1/training-plans/${planTwo.id}/sessions/${sessionInPlanOne.id}/link`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ activityId: activity.id }),
          },
        ),
      ),
    );
    expect(res.status).toBe(404);

    const unlinkRes = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(
          `http://test/api/v1/training-plans/${planTwo.id}/sessions/${sessionInPlanOne.id}/link`,
          { method: "DELETE" },
        ),
      ),
    );
    expect(unlinkRes.status).toBe(404);
  });

  it("400s a nested create with duplicate weekIndex values", async () => {
    const res = await withIdentity(identityA(), () =>
      app.fetch(
        new Request("http://test/api/v1/training-plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Dup Week Plan",
            startDate: "2026-02-01",
            endDate: "2026-02-14",
            weeks: [
              { weekIndex: 0, startDate: "2026-02-01" },
              { weekIndex: 0, startDate: "2026-02-08" },
            ],
          }),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("400s PATCH /:id when startDate alone would move past the stored endDate", async () => {
    const created = await createPlanWithChildren(identityA());

    const res = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startDate: "2026-02-01" }),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("surfaces a duplicate week index as an error, not a 500", async () => {
    const created = await createPlanWithChildren(identityA());

    const res = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}/weeks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weekIndex: 0, startDate: "2026-01-05" }),
        }),
      ),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("DELETE /:id cascades to weeks and sessions", async () => {
    const created = await createPlanWithChildren(identityA());

    const deleteRes = await withIdentity(identityA(), () =>
      app.fetch(
        new Request(`http://test/api/v1/training-plans/${created.id}`, { method: "DELETE" }),
      ),
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    const getRes = await withIdentity(identityA(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${created.id}`)),
    );
    expect(getRes.status).toBe(404);
  });
});
