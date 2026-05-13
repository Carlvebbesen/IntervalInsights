import { and, eq } from "drizzle-orm";
import type { GraphDb } from "../agent/graph_state";
import { logger } from "../logger";
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
  const log = logger.child({ fn: "findMatchingStructure" });
  const components = mapSegmentsToComponents(segments);
  const signature = generateIntervalSignature(components);
  log.info({ signature, trainingType, workComponents: components.length }, "looking up structure");

  const exact = await db
    .select()
    .from(intervalStructures)
    .where(eq(intervalStructures.signature, signature))
    .limit(1);

  if (exact.length > 0) {
    log.info(
      {
        structureId: exact[0].id,
        structureName: exact[0].name,
        structureTrainingType: exact[0].trainingType,
        activityTrainingType: trainingType,
      },
      "exact-match",
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
    log.info(
      {
        structureId: bestId,
        jaccard: Number(bestScore.toFixed(2)),
        threshold: JACCARD_THRESHOLD,
      },
      "fuzzy-match",
    );
    return { useExisting: true, structureId: bestId, signature };
  }
  log.info("no match — will create new structure");
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

  const log = logger.child({ fn: "persistSegmentsAndStructure", activityId });
  let structureId: number;
  if (check.useExisting && check.structureId !== undefined) {
    structureId = check.structureId;
    log.info({ structureId, signature: check.signature }, "reusing existing structureId");
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
    log.info(
      { structureId, structureName: newStructure.name, signature: check.signature },
      "created new structure",
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
    log.info(
      {
        structureId,
        draftOverride: draftOverride
          ? {
              segmentsFromLaps: draftOverride.segmentsFromLaps,
              acceptedSets: draftOverride.acceptedSets?.length ?? 0,
            }
          : null,
      },
      "activity linked to structure",
    );

    await tx.delete(intervalSegments).where(eq(intervalSegments.activityId, activityId));
    if (persistSegments) {
      await tx.insert(intervalSegments).values(segments);
      log.info({ count: segments.length }, "inserted segments");
    } else {
      log.info(
        { count: segments.length },
        "SKIPPED inserting segments (clean-laps path — re-derive on read)",
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
