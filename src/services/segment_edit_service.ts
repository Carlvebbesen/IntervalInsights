import { asc, eq } from "drizzle-orm";
import { AppError } from "../error";
import { recordSegmentEdit } from "../otel";
import * as activityRepo from "../repositories/activity_repository";
import type { InsertIntervalSegment, SelectIntervalSegment } from "../schema";
import { intervalSegments } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { StreamSet } from "../types/strava/IStream";
import { getStreamSet } from "./activity_source_service";
import { expandRestSegments } from "./segment_fold_service";
import {
  type FullSegmentSpec,
  recomputeSegmentStats,
  SegmentMappingError,
} from "./segment_mapping_service";
import { findMatchingStructure, persistSegmentsAndStructure } from "./signature_service";
import { resolveVenueContext } from "./venue_detection_service";

type Db = IGlobalBindings["db"];

type OwnedActivity = NonNullable<Awaited<ReturnType<typeof activityRepo.findByIdForUser>>>;

async function applySegmentEdit(
  db: Db,
  userId: string,
  activity: OwnedActivity,
  specs: FullSegmentSpec[],
  editKind: "bulk" | "single",
): Promise<{ intervalSegments: SelectIntervalSegment[] }> {
  if (!activity.trainingType) {
    throw new AppError(400, "Activity has no training type — cannot edit segments");
  }
  const tag = `[applySegmentEdit activity=${activity.id}]`;

  // latlng is fetched for venue detection (confirms a distance→venue snap).
  const streams = await getStreamSet(db, userId, activity.id, [
    "time",
    "distance",
    "heartrate",
    "latlng",
  ]);
  if (!streams?.time || !streams?.distance) {
    throw new AppError(400, "Activity streams missing time/distance — cannot recompute stats");
  }
  const statsStreams = streams as Required<Pick<StreamSet, "time" | "distance">> &
    Pick<StreamSet, "heartrate">;

  let computed: InsertIntervalSegment[];
  try {
    computed = recomputeSegmentStats(statsStreams, specs, activity.id, tag);
  } catch (err) {
    if (err instanceof SegmentMappingError) {
      throw new AppError(400, err.message);
    }
    throw err;
  }

  const venue = resolveVenueContext(streams);
  const check = await findMatchingStructure(db, computed, activity.trainingType, userId, venue);
  await persistSegmentsAndStructure(db, {
    activityId: activity.id,
    userId,
    trainingType: activity.trainingType,
    segments: computed,
    check,
    userNotes: activity.notes ?? "",
    feeling: activity.feeling ?? null,
    persistSegments: true,
    draftOverride: null,
  });

  recordSegmentEdit({
    editKind,
    source: activity.intervalsIcuId ? "intervals" : "strava",
    trainingType: activity.trainingType,
  });

  // Option B: expand folded recovery back into REST rows for the response shape.
  return { intervalSegments: expandRestSegments(await loadStoredSegments(db, activity.id)) };
}

function loadStoredSegments(db: Db, activityId: number) {
  return db
    .select()
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, activityId))
    .orderBy(asc(intervalSegments.segmentIndex));
}

export async function editSegments(
  db: Db,
  userId: string,
  activityId: number,
  specs: FullSegmentSpec[],
) {
  const activity = await activityRepo.requireOwnedActivity(db, userId, activityId);
  return applySegmentEdit(db, userId, activity, specs, "bulk");
}
