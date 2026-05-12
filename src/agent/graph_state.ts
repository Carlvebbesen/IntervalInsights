import { Annotation } from "@langchain/langgraph";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../schema";
import type { IntervalsIcuPrediction } from "../schema/activities";
import type { TrainingType } from "../schema/enums";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import type { WorkoutAnalysisOutput } from "./initial_analysis_agent";

export type GraphDb = NodePgDatabase<typeof schema>;

export type GraphConfigurable = {
  db: GraphDb;
  stravaAccessToken: string;
  clerkUserId: string;
  intervalsAthleteId: string | null;
};

const overwrite = <T>(_a: T, b: T): T => b;

export const AnalysisStateAnnotation = Annotation.Root({
  activityId: Annotation<number>(),
  stravaActivityId: Annotation<number>(),
  userId: Annotation<string>(),

  isIndoor: Annotation<boolean>({ reducer: overwrite, default: () => false }),
  activityTitle: Annotation<string>({ reducer: overwrite, default: () => "" }),
  activityDescription: Annotation<string>({ reducer: overwrite, default: () => "" }),
  activityStartDateLocal: Annotation<Date | null>({ reducer: overwrite, default: () => null }),
  activityType: Annotation<string>({ reducer: overwrite, default: () => "" }),
  totalElevationGain: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  streams: Annotation<StreamSet | null>({ reducer: overwrite, default: () => null }),
  laps: Annotation<Lap[]>({ reducer: overwrite, default: () => [] }),

  intervalsIcuPrediction: Annotation<IntervalsIcuPrediction | null>({
    reducer: overwrite,
    default: () => null,
  }),

  initialResult: Annotation<WorkoutAnalysisOutput | null>({
    reducer: overwrite,
    default: () => null,
  }),
  lapsMatchStructure: Annotation<boolean>({ reducer: overwrite, default: () => false }),

  userNotes: Annotation<string>({ reducer: overwrite, default: () => "" }),
  userSets: Annotation<ExpandedIntervalSet[]>({ reducer: overwrite, default: () => [] }),
  confirmedTrainingType: Annotation<TrainingType | null>({
    reducer: overwrite,
    default: () => null,
  }),
  feeling: Annotation<number | null>({ reducer: overwrite, default: () => null }),

  computedSegments: Annotation<InsertIntervalSegment[]>({
    reducer: overwrite,
    default: () => [],
  }),

  signatureCheck: Annotation<{
    useExisting: boolean;
    structureId?: number;
    signature: string;
  } | null>({
    reducer: overwrite,
    default: () => null,
  }),
});

export type AnalysisState = typeof AnalysisStateAnnotation.State;
