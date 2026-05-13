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
import type { DraftAnalysisResult } from "../schema/activities";
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
  const tag = "[findMatchingStructure]";
  const components = mapSegmentsToComponents(segments);
  const signature = generateIntervalSignature(components);
  console.log(
    `${tag} signature=${signature} trainingType=${trainingType} workComponents=${components.length}`,
  );

  const exact = await db
    .select()
    .from(intervalStructures)
    .where(eq(intervalStructures.signature, signature))
    .limit(1);

  if (exact.length > 0) {
    console.log(
      `${tag} exact-match -> structureId=${exact[0].id} name="${exact[0].name}" (structure.trainingType=${exact[0].trainingType}, activity.trainingType=${trainingType})`,
    );
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
    console.log(
      `${tag} fuzzy-match -> structureId=${bestId} jaccard=${bestScore.toFixed(2)} (≥${JACCARD_THRESHOLD})`,
    );
    return { useExisting: true, structureId: bestId, signature };
  }
  console.log(`${tag} no match — will create new structure`);
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
    draftOverride?: DraftAnalysisResult | null;
    persistSegments?: boolean;
  },
): Promise<void> {
  const {
    activityId,
    trainingType,
    segments,
    check,
    userNotes,
    feeling,
    draftOverride,
    persistSegments = true,
  } = params;

  const tag = `[persistSegmentsAndStructure activity=${activityId}]`;
  let structureId: number;
  if (check.useExisting && check.structureId !== undefined) {
    structureId = check.structureId;
    console.log(
      `${tag} reusing existing structureId=${structureId} (signature=${check.signature})`,
    );
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
    console.log(
      `${tag} created new structureId=${structureId} name="${newStructure.name}" signature=${check.signature}`,
    );
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
        draftAnalysisResult: draftOverride ?? null,
      })
      .where(eq(activities.id, activityId));
    console.log(
      `${tag} activity linked to structureId=${structureId} draftOverride=${draftOverride ? `segmentsFromLaps=${draftOverride.segmentsFromLaps} acceptedSets=${draftOverride.acceptedSets?.length ?? 0}` : "null"}`,
    );

    await tx.delete(intervalSegments).where(eq(intervalSegments.activityId, activityId));
    if (persistSegments) {
      await tx.insert(intervalSegments).values(segments);
      console.log(`${tag} inserted ${segments.length} segments`);
    } else {
      console.log(
        `${tag} SKIPPED inserting ${segments.length} segments (clean-laps path — re-derive on read)`,
      );
    }
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
