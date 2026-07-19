import type { z } from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import type { TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import { fetchFitnessDayBlock } from "./fitness_service";
import { applyHeatAdjustment, heatZoneForTrainingType, type WeatherInput } from "./heat_service";
import { fetchTrainingSummary } from "./intervals_wellness_service";
import { fetchPaceAnchor, fillPacesFromAnchor, type PaceAnchorResult } from "./pace_anchor_service";
import {
  applyReadinessAdjustment,
  getProposedPaceForStructure,
  type ReadinessSignals,
} from "./pace_service";
import { generateCompleteIntervalSet } from "./utils";

type Db = IGlobalBindings["db"];
type WorkoutSet = z.infer<typeof workoutSet>;

export interface PrescriptionPaceInput {
  sets: WorkoutSet[];
  sessionType: TrainingType | null;
  readiness?: ReadinessSignals;
  weather?: WeatherInput;
  asOf?: Date;
}

export interface PrescriptionPaceResult {
  paces: ExpandedIntervalSet[];
  penaltySecPerKm: number;
  advisory: string;
}

/**
 * Stage seams so the orchestration is unit-testable without a database; both
 * default to the real services.
 */
export interface PrescriptionPaceDeps {
  history: (db: Db, userId: string, sets: WorkoutSet[]) => Promise<ExpandedIntervalSet[]>;
  anchor: (db: Db, userId: string, asOf?: Date) => Promise<PaceAnchorResult>;
}

const defaultDeps: PrescriptionPaceDeps = {
  history: getProposedPaceForStructure,
  anchor: (db, userId, asOf) =>
    asOf ? fetchPaceAnchor(db, userId, asOf) : fetchPaceAnchor(db, userId),
};

export async function resolveReadiness(
  db: Db,
  userId: string,
  date: string,
): Promise<ReadinessSignals> {
  const [day, summary] = await Promise.all([
    fetchFitnessDayBlock(db, userId, date).catch(() => null),
    fetchTrainingSummary(db, userId).catch(() => null),
  ]);

  const ramp = summary && summary.status === "ok" ? summary.data.fitness.rampRate : null;
  const summaryData = summary && summary.status === "ok" ? summary.data : null;
  return {
    tsb: day?.tsb ?? null,
    ctl: day?.ctl ?? summaryData?.fitness.ctl ?? null,
    atl: day?.atl ?? summaryData?.fitness.atl ?? null,
    ramp: ramp ?? null,
    hrvStatus: day?.hrvStatus ?? null,
    sleepScore: day?.sleepScore ?? summaryData?.sleep.sleepScore ?? null,
  };
}

/**
 * Coach-chat carries weather as `unknown` (a validated-but-partial client payload).
 * The heat model needs both temperature and humidity, so anything else is dropped.
 */
export function toWeatherInput(weather: unknown): WeatherInput | undefined {
  if (!weather || typeof weather !== "object") return undefined;
  const w = weather as Record<string, unknown>;
  if (typeof w.temperatureC !== "number" || typeof w.humidity !== "number") return undefined;
  return {
    temperatureC: w.temperatureC,
    humidity: w.humidity,
    uvIndex: typeof w.uvIndex === "number" ? w.uvIndex : null,
    cloudCover: typeof w.cloudCover === "number" ? w.cloudCover : null,
    apparentTemperatureC:
      typeof w.apparentTemperatureC === "number" ? w.apparentTemperatureC : null,
  };
}

/** Lay the history paces (same expanded shape) onto the skeleton; shape mismatches pass through. */
function mergeHistoryPaces(
  skeleton: ExpandedIntervalSet[],
  history: ExpandedIntervalSet[],
): ExpandedIntervalSet[] {
  if (history.length !== skeleton.length) return skeleton;
  return skeleton.map((set, i) => {
    const h = history[i];
    if (!h || h.steps.length !== set.steps.length) return set;
    return {
      ...set,
      steps: set.steps.map((step, j) => ({
        ...step,
        target_pace: h.steps[j]?.target_pace ?? step.target_pace,
      })),
    };
  });
}

/**
 * The single prescription pace pipeline: history → anchor-fill → readiness → heat.
 * Every stage after the first degrades independently — an anchor or weather
 * failure skips that stage rather than failing the prescription.
 *
 * Prescription only. Post-hoc annotation of what an athlete actually ran
 * (`analysis_controller.getProposedPace`'s lap-derivation branch) must NOT go
 * through here: readiness and heat easing are meaningless when reconstructing a
 * completed effort.
 */
export async function computeAdjustedPace(
  db: Db,
  userId: string,
  input: PrescriptionPaceInput,
  deps: PrescriptionPaceDeps = defaultDeps,
): Promise<PrescriptionPaceResult> {
  const { sets, sessionType, readiness, weather, asOf } = input;

  const skeleton = generateCompleteIntervalSet(sets);
  const historyPaced = await deps.history(db, userId, sets);
  let paces = mergeHistoryPaces(skeleton, historyPaced);

  const anchor = await deps.anchor(db, userId, asOf).catch(() => null);
  if (anchor && anchor.status === "ok") {
    paces = fillPacesFromAnchor(paces, anchor.data.paces, sessionType);
  }

  let penaltySecPerKm = 0;
  const advisories: string[] = [];

  if (readiness) {
    const adjusted = applyReadinessAdjustment(paces, readiness);
    paces = adjusted.paces;
    penaltySecPerKm += adjusted.penaltySecPerKm;
    if (adjusted.advisory) advisories.push(adjusted.advisory);
  }

  if (weather) {
    try {
      const heat = applyHeatAdjustment(paces, weather, heatZoneForTrainingType(sessionType));
      paces = heat.paces;
      penaltySecPerKm += heat.penaltySecPerKm;
      if (heat.advisory) advisories.push(heat.advisory);
    } catch {
      // heat is advisory-only; a bad weather payload must not fail the prescription
    }
  }

  return { paces, penaltySecPerKm, advisory: advisories.filter(Boolean).join(" ") };
}
