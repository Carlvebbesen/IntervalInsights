// Boot-time seeder for the store-review demo account. Idempotent and
// self-healing: it wipes and reinserts the review user's synthetic corpus on
// every boot, keeping dates fresh and restoring anything a reviewer mutated.
// No-ops entirely unless the REVIEW_ACCOUNT_* env pair is configured.

import { eq, inArray } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { logger } from "../../logger";
import {
  activities,
  activityEvents,
  events,
  gears,
  intervalSegments,
  intervalStructures,
  users,
} from "../../schema";
import { setReviewUserId } from "../review_account";
import { buildDemoCorpus } from "./corpus";

export async function seedReviewAccountData(): Promise<void> {
  if (config.REVIEW_ACCOUNT_EMAIL === undefined) return;

  const user = await db.query.users.findFirst({
    where: eq(users.email, config.REVIEW_ACCOUNT_EMAIL),
    columns: { id: true },
  });
  if (!user) return;
  const userId = user.id;
  setReviewUserId(userId);

  const corpus = buildDemoCorpus(new Date());

  await db.transaction(async (tx) => {
    // Provider sentinel + premium role so the app gate passes and coach chat
    // works; leave consent timestamps null so the reviewer exercises them.
    await tx
      .update(users)
      .set({ stravaId: "0", role: "premium", maxHeartRate: 190, processHeartRate: true })
      .where(eq(users.id, userId));

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
