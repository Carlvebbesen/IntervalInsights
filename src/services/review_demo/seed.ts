// Store-review demo account seeding. Split into a cheap per-boot part
// (resolve + promote the review user, arm the in-memory isReviewUser cache) and
// the expensive corpus delete+reinsert, which now runs on demand via
// `scripts/seed_review_account.ts` and as a first-boot convenience.
// No-ops entirely unless the REVIEW_ACCOUNT_* env pair is configured.

import { count, eq, inArray } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { logger } from "../../logger";
import {
  activities,
  activityEvents,
  eventNotes,
  events,
  gears,
  intervalSegments,
  intervalStructures,
  users,
} from "../../schema";
import { setReviewUserId } from "../review_account";
import { buildDemoCorpus } from "./corpus";

// Cheap, safe on every boot: resolve the review user, promote it (provider
// sentinel + premium role so the app gate passes and coach chat works; consent
// timestamps left null so the reviewer exercises them) and arm isReviewUser().
// Returns the user id, or null when the env pair is unset or the row is missing.
export async function prepareReviewAccount(): Promise<string | null> {
  if (config.REVIEW_ACCOUNT_EMAIL === undefined) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.email, config.REVIEW_ACCOUNT_EMAIL),
    columns: { id: true },
  });
  if (!user) return null;

  await db
    .update(users)
    .set({ stravaId: "0", role: "premium", maxHeartRate: 190, processHeartRate: true })
    .where(eq(users.id, user.id));
  setReviewUserId(user.id);
  return user.id;
}

export async function hasReviewDemoData(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(activities)
    .where(eq(activities.userId, userId));
  return (row?.n ?? 0) > 0;
}

// Expensive delete+reinsert of the synthetic corpus. Idempotent and
// self-healing: wipes and reinserts the review user's data, freshening dates and
// restoring anything a reviewer mutated. Caller must have run prepareReviewAccount.
export async function reseedReviewAccountData(userId: string): Promise<void> {
  const corpus = buildDemoCorpus(new Date());

  await db.transaction(async (tx) => {
    if (corpus.structures.length > 0) {
      await tx
        .insert(intervalStructures)
        .values(corpus.structures.map((s) => ({ name: s.name, signature: s.signature })))
        .onConflictDoNothing({ target: intervalStructures.signature });
    }
    const sigs = corpus.structures.map((s) => s.signature);
    const structureRows = sigs.length
      ? await tx
          .select({ id: intervalStructures.id, signature: intervalStructures.signature })
          .from(intervalStructures)
          .where(inArray(intervalStructures.signature, sigs))
      : [];
    const structureIdBySig = new Map(structureRows.map((r) => [r.signature as string, r.id]));

    // events → cascades activity_events; activities → cascades interval_segments.
    await tx.delete(events).where(eq(events.userId, userId));
    await tx.delete(activities).where(eq(activities.userId, userId));
    await tx.delete(gears).where(eq(gears.userId, userId));

    const gearIdByIndex: number[] = [];
    for (const g of corpus.gears) {
      const [row] = await tx
        .insert(gears)
        .values({ ...g, userId })
        .returning({ id: gears.id });
      gearIdByIndex.push(row.id);
    }

    const demoKeyToActivityId = new Map<string, number>();
    for (const a of corpus.activities) {
      const localGearId = a.gearRef != null ? (gearIdByIndex[a.gearRef] ?? null) : null;
      const intervalStructureId = a.structureSignature
        ? (structureIdBySig.get(a.structureSignature) ?? null)
        : null;
      const [row] = await tx
        .insert(activities)
        .values({ ...a.columns, userId, localGearId, intervalStructureId })
        .returning({ id: activities.id });
      demoKeyToActivityId.set(a.demoKey, row.id);
      if (a.segments.length > 0) {
        await tx
          .insert(intervalSegments)
          .values(a.segments.map((s) => ({ ...s, activityId: row.id })));
      }
    }

    for (const e of corpus.events) {
      const [row] = await tx
        .insert(events)
        .values({ ...e.event, userId })
        .returning({ id: events.id });
      await tx.insert(eventNotes).values(
        e.notes.map((n) => ({
          eventId: row.id,
          userId,
          note: n.note,
          source: n.source,
          occurredAt: n.occurredAt,
          trend: n.trend ?? null,
          severity: n.severity ?? null,
          isAnchor: n.isAnchor ?? false,
        })),
      );
      const links = e.activityDemoKeys
        .map((k) => demoKeyToActivityId.get(k))
        .filter((id): id is number => id != null)
        .map((activityId) => ({ activityId, eventId: row.id }));
      if (links.length > 0) await tx.insert(activityEvents).values(links);
    }
  });

  logger.info(
    {
      userId,
      activities: corpus.activities.length,
      gears: corpus.gears.length,
      events: corpus.events.length,
      structures: corpus.structures.length,
    },
    "seeded store-review demo data",
  );
}

// Full entry point for the on-demand script: prepare then force a reseed.
export async function seedReviewAccountData(): Promise<void> {
  const userId = await prepareReviewAccount();
  if (userId) await reseedReviewAccountData(userId);
}
