import { and, eq } from "drizzle-orm";
import type { GraphDb } from "../agent/graph_state";
import {
  activities,
  determineIntervalType,
  generateIntervalSignature,
  generateStructureName,
  type InsertIntervalSegment,
  intervalSegments,
  intervalStructures,
  mapSegmentsToComponents,
} from "../schema";
import type { TrainingType } from "../schema/enums";

export type SignatureCheck = {
  useExisting: boolean;
  structureId?: number;
  signature: string;
};

const JACCARD_THRESHOLD = 0.7;

export async function findMatchingStructure(
  db: GraphDb,
  segments: InsertIntervalSegment[],
  trainingType: TrainingType,
  userId: string,
): Promise<SignatureCheck> {
  const components = mapSegmentsToComponents(segments);
  const signature = generateIntervalSignature(components);

  const exact = await db
    .select()
    .from(intervalStructures)
    .where(
      and(
        eq(intervalStructures.signature, signature),
        eq(intervalStructures.trainingType, trainingType),
      ),
    )
    .limit(1);

  if (exact.length > 0) {
    return { useExisting: true, structureId: exact[0].id, signature };
  }

  const signatureParts = signature.split("-").sort();
  const candidates = await db
    .selectDistinct({ id: intervalStructures.id, signature: intervalStructures.signature })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .where(and(eq(activities.userId, userId), eq(intervalStructures.trainingType, trainingType)));

  let bestId: number | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (!candidate.signature) continue;
    const candidateParts = candidate.signature.split("-").sort();
    const intersection = signatureParts.filter((p) => candidateParts.includes(p));
    const unionSize = new Set([...signatureParts, ...candidateParts]).size;
    const jaccard = intersection.length / unionSize;
    if (jaccard >= JACCARD_THRESHOLD && jaccard > bestScore) {
      bestScore = jaccard;
      bestId = candidate.id;
    }
  }

  if (bestId !== undefined) {
    return { useExisting: true, structureId: bestId, signature };
  }
  return { useExisting: false, signature };
}

export async function persistSegmentsAndStructure(
  db: GraphDb,
  params: {
    activityId: number;
    userId: string;
    trainingType: TrainingType;
    segments: InsertIntervalSegment[];
    check: SignatureCheck;
    userNotes: string;
    feeling: number | null;
  },
): Promise<void> {
  const { activityId, trainingType, segments, check, userNotes, feeling } = params;

  let structureId: number;
  if (check.useExisting && check.structureId !== undefined) {
    structureId = check.structureId;
  } else {
    const components = mapSegmentsToComponents(segments);
    const [newStructure] = await db
      .insert(intervalStructures)
      .values({
        name: generateStructureName(components),
        signature: check.signature || null,
        trainingType,
        intervalType: determineIntervalType(segments),
      })
      .returning();
    structureId = newStructure.id;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(activities)
      .set({
        intervalStructureId: structureId,
        trainingType,
        analysisStatus: "completed",
        analyzedAt: new Date(),
        notes: userNotes,
        feeling: feeling ?? undefined,
        draftAnalysisResult: null,
      })
      .where(eq(activities.id, activityId));

    await tx.delete(intervalSegments).where(eq(intervalSegments.activityId, activityId));
    await tx.insert(intervalSegments).values(segments);
  });
}

export async function completeWithoutSegments(
  db: GraphDb,
  params: {
    activityId: number;
    trainingType: TrainingType;
    userNotes: string;
    feeling: number | null;
  },
): Promise<void> {
  const { activityId, trainingType, userNotes, feeling } = params;
  await db
    .update(activities)
    .set({
      trainingType,
      analysisStatus: "completed",
      analyzedAt: new Date(),
      notes: userNotes,
      feeling: feeling ?? undefined,
      draftAnalysisResult: null,
    })
    .where(eq(activities.id, activityId));
}
