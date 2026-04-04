import { Annotation } from "@langchain/langgraph";
import type { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import type { TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";

// Last-write-wins reducer — used for all fields that are simply overwritten by nodes
const overwrite = <T>(a: T, b: T): T => b;

export const AnalysisStateAnnotation = Annotation.Root({
  // Required inputs — must be provided on first invocation
  activityId: Annotation<number>(),
  stravaActivityId: Annotation<number>(),
  userId: Annotation<string>(),

  // Set by classifyActivity
  isIndoor: Annotation<boolean>({
    reducer: overwrite,
    default: () => false,
  }),
  initialResult: Annotation<WorkoutAnalysisOutput | null>({
    reducer: overwrite,
    default: () => null,
  }),
  canSkipComplete: Annotation<boolean>({
    reducer: overwrite,
    default: () => false,
  }),
  lapsMatchStructure: Annotation<boolean>({
    reducer: overwrite,
    default: () => false,
  }),

  // Set on graph resume (from user input via interrupt)
  userNotes: Annotation<string>({
    reducer: overwrite,
    default: () => "",
  }),
  userSets: Annotation<ExpandedIntervalSet[]>({
    reducer: overwrite,
    default: () => [],
  }),
  confirmedTrainingType: Annotation<TrainingType | null>({
    reducer: overwrite,
    default: () => null,
  }),

  // Set by runCompleteAnalysis
  computedSegments: Annotation<InsertIntervalSegment[]>({
    reducer: overwrite,
    default: () => [],
  }),

  // Set by validateSignature
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
