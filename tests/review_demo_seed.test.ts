import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config";
import { activities, events, gears, users } from "../src/schema";
import { seedReviewAccountData } from "../src/services/review_demo/seed";
import { deleteTestUser, getDb } from "./helpers/db";

const db = getDb();
const email = config.REVIEW_ACCOUNT_EMAIL as string;

let reviewUserId: string;

async function countActivities(userId: string): Promise<number> {
  return (await db.select({ id: activities.id }).from(activities).where(eq(activities.userId, userId)))
    .length;
}
async function countGears(userId: string): Promise<number> {
  return (await db.select({ id: gears.id }).from(gears).where(eq(gears.userId, userId))).length;
}
async function countEvents(userId: string): Promise<number> {
  return (await db.select({ id: events.id }).from(events).where(eq(events.userId, userId))).length;
}

beforeAll(async () => {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (existing) await deleteTestUser(existing.id);
  const [row] = await db
    .insert(users)
    .values({ email, name: "Store Review", emailVerified: true, role: "guest" })
    .returning({ id: users.id });
  reviewUserId = row.id;
});

afterAll(async () => {
  if (reviewUserId) await deleteTestUser(reviewUserId);
});

describe("seedReviewAccountData", () => {
  it("promotes the review user and seeds demo data", async () => {
    await seedReviewAccountData();

    const u = await db.query.users.findFirst({
      where: eq(users.id, reviewUserId),
      columns: { stravaId: true, role: true, processHeartRate: true, maxHeartRate: true },
    });
    expect(u?.stravaId).toBe("0");
    expect(u?.role).toBe("premium");
    expect(u?.processHeartRate).toBe(true);
    expect(u?.maxHeartRate).toBe(190);

    expect(await countActivities(reviewUserId)).toBeGreaterThan(0);
    expect(await countGears(reviewUserId)).toBeGreaterThan(0);
    expect(await countEvents(reviewUserId)).toBeGreaterThan(0);
  });

  it("is idempotent across repeated runs", async () => {
    const before = await countActivities(reviewUserId);
    const beforeGears = await countGears(reviewUserId);
    const beforeEvents = await countEvents(reviewUserId);

    await seedReviewAccountData();

    expect(await countActivities(reviewUserId)).toBe(before);
    expect(await countGears(reviewUserId)).toBe(beforeGears);
    expect(await countEvents(reviewUserId)).toBe(beforeEvents);
  });

  it("no-ops when the review env pair is unset", async () => {
    await db.delete(activities).where(eq(activities.userId, reviewUserId));

    const original = config.REVIEW_ACCOUNT_EMAIL;
    (config as { REVIEW_ACCOUNT_EMAIL?: string }).REVIEW_ACCOUNT_EMAIL = undefined;
    try {
      await seedReviewAccountData();
    } finally {
      (config as { REVIEW_ACCOUNT_EMAIL?: string }).REVIEW_ACCOUNT_EMAIL = original;
    }

    expect(await countActivities(reviewUserId)).toBe(0);
  });
});
