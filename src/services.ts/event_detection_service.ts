import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  type EventAttributeOutput,
  invokeEventDetectionAgent,
  type KnownAttributeKey,
} from "../agent/event_detection_agent";
import type { GraphDb } from "../agent/graph_state";
import { invokeWithRateLimitRetry } from "../agent/model";
import {
  activityEvents,
  eventAttributes,
  events,
  type InsertEvent,
  type InsertEventAttribute,
} from "../schema";
import type { AttributeValueType, EventType } from "../schema/enums";

const typeLocKey = (type: EventType, loc: string | null): string =>
  `${type}|${(loc ?? "").toLowerCase().trim()}`;

function attributeRowsFor(
  eventId: number,
  userId: string,
  atts: EventAttributeOutput[],
): InsertEventAttribute[] {
  const seen = new Set<string>();
  const rows: InsertEventAttribute[] = [];
  for (const a of atts) {
    const key = a.key.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      eventId,
      userId,
      key,
      valueType: a.type satisfies AttributeValueType,
      value: a.value,
    });
  }
  return rows;
}

export type EventDetectionInput = {
  activityId: number;
  userId: string;
  title: string;
  description: string;
  notes: string;
  activityStartDateLocal: Date | null;
};

export async function detectAndPersistEvents(
  db: GraphDb,
  input: EventDetectionInput,
): Promise<void> {
  const { activityId, userId, title, description, notes, activityStartDateLocal } = input;
  if (!title && !description && !notes) return;

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const [alreadyLinked, recent, knownKeys] = await Promise.all([
    db
      .select({
        id: events.id,
        eventType: events.eventType,
        bodyLocation: events.bodyLocation,
        description: events.description,
        lastOccurrence: events.lastOccurrence,
        status: events.status,
      })
      .from(activityEvents)
      .innerJoin(events, eq(events.id, activityEvents.eventId))
      .where(eq(activityEvents.activityId, activityId)),
    db
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), gte(events.lastOccurrence, oneYearAgo))),
    db
      .select({
        key: eventAttributes.key,
        valueType: eventAttributes.valueType,
        sampleValue: sql<unknown>`(array_agg(${eventAttributes.value} ORDER BY ${eventAttributes.createdAt} DESC))[1]`,
      })
      .from(eventAttributes)
      .where(eq(eventAttributes.userId, userId))
      .groupBy(eventAttributes.key, eventAttributes.valueType)
      .orderBy(desc(sql`max(${eventAttributes.createdAt})`))
      .limit(50),
  ]);

  const alreadyLinkedIds = new Set(alreadyLinked.map((r) => r.id));
  const alreadyLinkedTypeLoc = new Set(
    alreadyLinked.map((r) => typeLocKey(r.eventType, r.bodyLocation)),
  );
  const recentById = new Map(recent.map((r) => [r.id, r]));

  const knownAttributeKeys: KnownAttributeKey[] = knownKeys.map((k) => ({
    key: k.key,
    valueType: k.valueType as EventAttributeOutput["type"],
    sampleValue: JSON.stringify(k.sampleValue),
  }));

  const result = await invokeWithRateLimitRetry(() =>
    invokeEventDetectionAgent(
      title,
      description,
      notes,
      recent.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        bodyLocation: r.bodyLocation,
        description: r.description,
        lastOccurrence: r.lastOccurrence,
        status: r.status,
        alreadyLinkedToThisActivity: alreadyLinkedIds.has(r.id),
      })),
      knownAttributeKeys,
    ),
  );
  if (!result || result.events.length === 0) return;

  const seen = new Set<string>();
  const deduped = result.events.filter((e) => {
    const key =
      e.linkedEventId !== null
        ? `id:${e.linkedEventId}`
        : `new:${typeLocKey(e.eventType, e.bodyLocation)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const activityStart = activityStartDateLocal ?? new Date();

  await db.transaction(async (tx) => {
    for (const e of deduped) {
      let eventId: number;

      if (e.linkedEventId !== null) {
        const existing = recentById.get(e.linkedEventId);
        if (!existing) continue;
        if (alreadyLinkedIds.has(existing.id)) continue;

        const updates: Partial<InsertEvent> = { updatedAt: new Date() };
        if (activityStart > existing.lastOccurrence) {
          updates.lastOccurrence = activityStart;
        }
        if (e.description && e.description !== existing.description) {
          updates.description = e.description;
        }
        if (e.markResolved && existing.status !== "resolved") {
          updates.status = "resolved";
          updates.resolvedAt = activityStart;
        }
        await tx.update(events).set(updates).where(eq(events.id, existing.id));
        eventId = existing.id;

        const attrRows = attributeRowsFor(eventId, userId, e.attributes ?? []);
        if (attrRows.length > 0) {
          await tx
            .insert(eventAttributes)
            .values(attrRows)
            .onConflictDoUpdate({
              target: [eventAttributes.eventId, eventAttributes.key],
              set: {
                valueType: sql`excluded.value_type`,
                value: sql`excluded.value`,
              },
            });
        }
      } else {
        const key = typeLocKey(e.eventType, e.bodyLocation);
        if (alreadyLinkedTypeLoc.has(key)) continue;

        const [created] = await tx
          .insert(events)
          .values({
            userId,
            eventType: e.eventType,
            bodyLocation: e.bodyLocation,
            description: e.description,
            startTime: activityStart,
            lastOccurrence: activityStart,
            status: e.markResolved ? "resolved" : "active",
            resolvedAt: e.markResolved ? activityStart : null,
          })
          .returning({ id: events.id });
        eventId = created.id;
        alreadyLinkedTypeLoc.add(key);

        const attrRows = attributeRowsFor(eventId, userId, e.attributes ?? []);
        if (attrRows.length > 0) {
          await tx.insert(eventAttributes).values(attrRows);
        }
      }

      alreadyLinkedIds.add(eventId);

      await tx.insert(activityEvents).values({ activityId, eventId }).onConflictDoNothing();
    }
  });
}
