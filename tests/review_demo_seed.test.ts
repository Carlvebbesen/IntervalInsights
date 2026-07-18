import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config";
import { activities, events, gears, users } from "../src/schema";
import { isReviewUser, setReviewUserId } from "../src/services/review_account";
import {
  hasReviewDemoData,
  prepareReviewAccount,
  reseedReviewAccountData,
  seedReviewAccountData,
} from "../src/services/review_demo/seed";
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
async function activityIds(userId: string): Promise<number[]> {
  return (await db.select({ id: activities.id }).from(activities).where(eq(activities.userId, userId)))
    .map((r) => r.id)
    .sort((a, b) => a - b);
}
async function resetToBaselineGuest(userId: string): Promise<void> {
  await db.delete(events).where(eq(events.userId, userId));
  await db.delete(activities).where(eq(activities.userId, userId));
  await db.delete(gears).where(eq(gears.userId, userId));
  await db
    .update(users)
    .set({ stravaId: null, role: "guest", maxHeartRate: null, processHeartRate: false })
    .where(eq(users.id, userId));
  setReviewUserId("");
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

describe("prepareReviewAccount", () => {
  it("arms isReviewUser and promotes the user without inserting any activity", async () => {
    await resetToBaselineGuest(reviewUserId);
    expect(isReviewUser(reviewUserId)).toBe(false);

    const id = await prepareReviewAccount();

    expect(id).toBe(reviewUserId);
    expect(isReviewUser(reviewUserId)).toBe(true);
    const u = await db.query.users.findFirst({
      where: eq(users.id, reviewUserId),
      columns: { stravaId: true, role: true, processHeartRate: true, maxHeartRate: true },
    });
    expect(u?.stravaId).toBe("0");
    expect(u?.role).toBe("premium");
    expect(u?.processHeartRate).toBe(true);
    expect(u?.maxHeartRate).toBe(190);
    expect(await countActivities(reviewUserId)).toBe(0);
  });

  it("returns null and promotes nothing when the env pair is unset", async () => {
    await resetToBaselineGuest(reviewUserId);

    const original = config.REVIEW_ACCOUNT_EMAIL;
    (config as { REVIEW_ACCOUNT_EMAIL?: string }).REVIEW_ACCOUNT_EMAIL = undefined;
    let id: string | null;
    try {
      id = await prepareReviewAccount();
    } finally {
      (config as { REVIEW_ACCOUNT_EMAIL?: string }).REVIEW_ACCOUNT_EMAIL = original;
    }

    expect(id).toBeNull();
    const u = await db.query.users.findFirst({
      where: eq(users.id, reviewUserId),
      columns: { stravaId: true, role: true },
    });
    expect(u?.stravaId).toBeNull();
    expect(u?.role).toBe("guest");
  });
});

describe("hasReviewDemoData", () => {
  it("is false when empty and true after a seed", async () => {
    await resetToBaselineGuest(reviewUserId);
    expect(await hasReviewDemoData(reviewUserId)).toBe(false);

    await seedReviewAccountData();
    expect(await hasReviewDemoData(reviewUserId)).toBe(true);
  });
});

describe("guarded first-boot seeding", () => {
  async function guardedBoot(): Promise<string | null> {
    const id = await prepareReviewAccount();
    if (id && !(await hasReviewDemoData(id))) await reseedReviewAccountData(id);
    return id;
  }

  it("seeds only when the account is empty and skips the reseed otherwise", async () => {
    await resetToBaselineGuest(reviewUserId);

    await guardedBoot();
    const seededIds = await activityIds(reviewUserId);
    expect(seededIds.length).toBeGreaterThan(0);

    // Second boot arms/promotes but must NOT delete+reinsert (ids stay stable).
    await guardedBoot();
    expect(await activityIds(reviewUserId)).toEqual(seededIds);
  });
});
