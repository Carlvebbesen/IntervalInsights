import { Annotation } from "@langchain/langgraph";
import type { EventType, TrainingType } from "../../schema/enums";
import type { GraphDb } from "../graph_state";
import type { GeneratedWeekSessions, PlanMacro, PlanReviewAction } from "./plan_builder_schemas";

export type PlanBuilderInput = {
  name?: string | null;
  raceEventId?: number | null;
  startDate: string;
  endDate: string;
  goalText?: string | null;
};

export type AthleteRaceContext = {
  name: string;
  date: string;
  distanceMeters: number;
  targetTimeSeconds: number | null;
  priority: string;
};

export type AthleteWeekSummary = {
  weekStart: string;
  totalDistanceMeters: number;
  typeCounts: Record<string, number>;
};

export type AthleteFitness = {
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  rampRate: number | null;
};

export type AthletePredictedRace = {
  distanceMeters: number;
  timeSeconds: number;
};

export type AthleteRaceAbility = {
  vdot: number | null;
  criticalSpeedMps: number | null;
  predicted: AthletePredictedRace[];
};

export type AthleteBaselineVolume = {
  trailing4WeekAvgWeeklyMeters: number | null;
  longestRunLast30dMeters: number | null;
};

export type ActiveHealthEvent = {
  type: EventType;
  bodyLocation: string | null;
  description: string;
  since: string;
};

export type WorkoutVocabulary = {
  types: TrainingType[];
  hasStructuredIntervalHistory: boolean;
};

export type AthleteContext = {
  athleteName: string | null;
  maxHeartRate: number | null;
  intervalsConnected: boolean;
  race: AthleteRaceContext | null;
  recentWeeks: AthleteWeekSummary[];
  fitness: AthleteFitness | null;
  raceAbility: AthleteRaceAbility | null;
  baselineVolume: AthleteBaselineVolume | null;
  activeHealthEvents: ActiveHealthEvent[];
  workoutVocabulary: WorkoutVocabulary;
};

export type PlanBuilderConfigurable = {
  db: GraphDb;
  thread_id: string;
};

const overwrite = <T>(_a: T, b: T): T => b;

export const PlanBuilderStateAnnotation = Annotation.Root({
  userId: Annotation<string>(),
  input: Annotation<PlanBuilderInput>({
    reducer: overwrite,
    default: () => ({ startDate: "", endDate: "" }),
  }),
  athleteContext: Annotation<AthleteContext | null>({ reducer: overwrite, default: () => null }),
  macro: Annotation<PlanMacro | null>({ reducer: overwrite, default: () => null }),
  macroFeedback: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
  sessionsByWeek: Annotation<GeneratedWeekSessions[]>({ reducer: overwrite, default: () => [] }),
  sessionsFeedback: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
  action: Annotation<PlanReviewAction | null>({ reducer: overwrite, default: () => null }),
  persistedPlanId: Annotation<number | null>({ reducer: overwrite, default: () => null }),
});

export type PlanBuilderState = typeof PlanBuilderStateAnnotation.State;
