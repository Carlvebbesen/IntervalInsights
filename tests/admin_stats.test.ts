import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { getUserStats } from "../src/repositories/user_repository";
import { users } from "../src/schema";
import { REVIEW_STRAVA_ID } from "../src/services/review_account";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

// getUserStats counts every row in the shared test DB, so assert on deltas
// against a baseline rather than absolute totals.
const db = getDb();

let stravaUser: { id: string };
let intervalsUser: { id: string };
let reviewUser: { id: string };
let unconnectedUser: { id: string };
let baseline: Awaited<ReturnType<typeof getUserStats>>;
let after: Awaited<ReturnType<typeof getUserStats>>;

beforeAll(async () => {
  baseline = await getUserStats(db);

  stravaUser = await createTestUser({ strava: false, intervals: false });
  intervalsUser = await createTestUser({ strava: false, intervals: false });
  reviewUser = await createTestUser({ strava: false, intervals: false });
  unconnectedUser = await createTestUser({ strava: false, intervals: false });

  await db
    .update(users)
    .set({ stravaId: `test_strava_${stravaUser.id}` })
    .where(eq(users.id, stravaUser.id));
  await db
    .update(users)
    .set({ intervalsAthleteId: `test_intervals_${intervalsUser.id}` })
    .where(eq(users.id, intervalsUser.id));
  await db
    .update(users)
    .set({ stravaId: REVIEW_STRAVA_ID })
    .where(eq(users.id, reviewUser.id));

  after = await getUserStats(db);
});

afterAll(async () => {
  await deleteTestUser(stravaUser.id);
  await deleteTestUser(intervalsUser.id);
  await deleteTestUser(reviewUser.id);
  await deleteTestUser(unconnectedUser.id);
  await closePool();
});

describe("getUserStats connection counts", () => {
  it("counts a user with a real strava_id", () => {
    expect(after.stravaConnected - baseline.stravaConnected).toBe(1);
  });

  it("counts a user with an intervals_athlete_id", () => {
    expect(after.intervalsConnected - baseline.intervalsConnected).toBe(1);
  });

  it("excludes the review demo account's strava_id sentinel", () => {
    // Four users added, two of them carry a non-null strava_id — only the
    // non-sentinel one is a real connection.
    expect(after.totalUsers - baseline.totalUsers).toBe(4);
    expect(after.stravaConnected - baseline.stravaConnected).toBe(1);
  });
});
