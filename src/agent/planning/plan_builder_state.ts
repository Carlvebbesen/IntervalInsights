import { Annotation } from "@langchain/langgraph";
import type { EventType, TrainingType } from "../../schema/enums";
import type { GraphDb } from "../graph_state";
import {
  type GeneratedWeekSessions,
  MAX_REVIEW_ROUNDS,
  type PlanMacro,
  type PlanNotice,
  type PlanReviewAction,
} from "./plan_builder_schemas";

// Runna-style 2-axis aggressiveness dial (per-plan). The volume axis drives the
// deterministic macro ramp ceiling (see guards.VOLUME_RAMP); the intensity axis
// is plumbed + stored now but only affects session quality-counts in a later wave.
export const VOLUME_AGGRESSIVENESS = ["gradual", "steady", "progressive"] as const;
export type VolumeAggressiveness = (typeof VOLUME_AGGRESSIVENESS)[number];
export const DEFAULT_VOLUME_AGGRESSIVENESS: VolumeAggressiveness = "steady";

export const INTENSITY_AGGRESSIVENESS = ["comfortable", "balanced", "challenging"] as const;
export type IntensityAggressiveness = (typeof INTENSITY_AGGRESSIVENESS)[number];
export const DEFAULT_INTENSITY_AGGRESSIVENESS: IntensityAggressiveness = "balanced";

export type PlanBuilderInput = {
  name?: string | null;
  raceEventId?: number | null;
  startDate: string;
  endDate: string;
  goalText?: string | null;
  constraintsText?: string | null;
  intakeBriefText?: string | null;
  volumeAggressiveness?: VolumeAggressiveness;
  intensityAggressiveness?: IntensityAggressiveness;
  maxWeeklyVolumeMeters?: number | null;
  daysPerWeek?: number | null;
  preferredLongRunDay?: number | null;
  crossTrainingPerWeek?: number | null;
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
  /**
   * Proven capacity over the last ~26 weeks: the best trailing-4-consecutive-week
   * average (needing ≥3 active weeks in the slice) — a comeback athlete's real
   * ceiling, not their vacation-shrunken trailing month. Null without such a block.
   */
  provenWeeklyMeters: number | null;
  /** Longest single run in the same ~26-week window. */
  provenLongestRunMeters: number | null;
};

export type ActiveHealthEvent = {
  type: EventType;
  bodyLocation: string | null;
  description: string;
  since: string;
};

export type WorkoutVocabularyStructure = {
  name: string;
  activityCount: number;
  lastDoneAt: string | null;
};

export type WorkoutVocabulary = {
  types: TrainingType[];
  hasStructuredIntervalHistory: boolean;
  structures: WorkoutVocabularyStructure[];
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
  // Split so a regeneration node can overwrite its own guard notices without
  // clobbering the "I applied this" notices the review gate produced for the
  // same round; the interrupt payload concatenates the two.
  feedbackNotices: Annotation<PlanNotice[]>({ reducer: overwrite, default: () => [] }),
  guardNotices: Annotation<PlanNotice[]>({ reducer: overwrite, default: () => [] }),
  // Set once by gatherContext and never written by regeneration/review nodes, so
  // a degraded context ("built WITHOUT injury records") stays visible through
  // every review loop and on the terminal done event.
  contextNotices: Annotation<PlanNotice[]>({ reducer: overwrite, default: () => [] }),
  action: Annotation<PlanReviewAction | null>({ reducer: overwrite, default: () => null }),
  persistedPlanId: Annotation<number | null>({ reducer: overwrite, default: () => null }),
});

export type PlanBuilderState = typeof PlanBuilderStateAnnotation.State;

/**
 * The one concatenation order for the three notice channels (see the channel
 * split documented on the annotation above). Tolerates missing channels so the
 * controller can pass a possibly-empty checkpoint's values.
 */
export function collectNotices(
  state: Partial<Pick<PlanBuilderState, "contextNotices" | "feedbackNotices" | "guardNotices">>,
): PlanNotice[] {
  return [
    ...(state.contextNotices ?? []),
    ...(state.feedbackNotices ?? []),
    ...(state.guardNotices ?? []),
  ];
}

export function reviewRoundMeta(round: number) {
  return {
    round,
    maxRounds: MAX_REVIEW_ROUNDS,
    roundsRemaining: Math.max(0, MAX_REVIEW_ROUNDS - round),
  };
}
