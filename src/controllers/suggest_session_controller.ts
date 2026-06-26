import type { z } from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { invokeSuggestSessionAgent } from "../agent/suggest_session_agent";
import { AppError } from "../error";
import type { Logger } from "../logger";
import * as structureRepo from "../repositories/interval_structure_repository";
import type {
  ProposedTrainingArtifactSchema,
  SuggestSessionResponseSchema,
  Weather,
} from "../schemas/api_schemas";
import { fetchFitnessDayBlock } from "../services/fitness_service";
import { applyHeatAdjustment, heatZoneForTrainingType } from "../services/heat_service";
import { fetchTrainingSummary } from "../services/intervals_wellness_service";
import {
  applyReadinessAdjustment,
  getProposedPaceForStructure,
  type ReadinessSignals,
} from "../services/pace_service";
import { toISODate } from "../services/utils";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];
type WorkoutSet = z.infer<typeof workoutSet>;
type SuggestSessionResponse = z.infer<typeof SuggestSessionResponseSchema>;
type ProposedTraining = z.infer<typeof ProposedTrainingArtifactSchema>;

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: SuggestSessionResponse }>();

function hashStructure(sets: WorkoutSet[]): string {
  return JSON.stringify(
    sets.map((s) => ({
      r: s.set_reps,
      sr: s.set_recovery ?? null,
      steps: s.steps.map((st) => [st.reps, st.work_type, st.work_value, st.recovery_value ?? null]),
    })),
  );
}

function cacheKey(
  userId: string,
  date: string,
  structureId: number | undefined,
  sets: WorkoutSet[],
  weather: Weather | undefined,
): string {
  const shape = structureId != null ? `id:${structureId}` : `h:${hashStructure(sets)}`;
  const w = weather ? `|w:${Math.round(weather.temperatureC)}:${Math.round(weather.humidity)}` : "";
  return `${userId}|${date}|${shape}${w}`;
}

function toWorkoutStructure(
  sets: WorkoutSet[],
  paced: ExpandedIntervalSet[] | null,
): ProposedTraining["structure"] {
  let setCursor = 0;
  return sets.map((set) => {
    const group = paced ? paced.slice(setCursor, setCursor + set.set_reps) : [];
    setCursor += set.set_reps;
    let stepOffset = 0;
    const steps = set.steps.map((step) => {
      const paces: number[] = [];
      for (const expandedSet of group) {
        for (let rep = 0; rep < step.reps; rep++) {
          const p = expandedSet.steps[stepOffset + rep]?.target_pace;
          if (typeof p === "number") paces.push(p);
        }
      }
      stepOffset += step.reps;
      const mean = paces.length > 0 ? paces.reduce((a, b) => a + b, 0) / paces.length : null;
      return {
        reps: step.reps,
        work_type: step.work_type,
        work_value: step.work_value,
        recovery_type: step.recovery_type ?? null,
        recovery_value: step.recovery_value ?? null,
        target_pace: mean === null ? null : Math.round(mean * 100) / 100,
      };
    });
    return { set_reps: set.set_reps, set_recovery: set.set_recovery ?? null, steps };
  });
}

function fmtPaceSecPerKm(mps: number | null | undefined): string {
  if (mps == null || mps <= 0) return "n/a";
  const secPerKm = 1000 / mps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

async function buildHistorySummary(
  db: Db,
  userId: string,
  structureId: number | undefined,
): Promise<string> {
  if (structureId == null) return "";
  const rows = await structureRepo.structureHistory(db, userId, structureId);
  if (rows.length === 0) return "";
  const recent = rows.slice(-5);
  const lines = recent.map((r) => {
    const date = r.date.toISOString().slice(0, 10);
    const km = (r.distance / 1000).toFixed(1);
    const pace = r.avgWorkPaceSecPerKm != null ? Number(r.avgWorkPaceSecPerKm) : null;
    const paceStr =
      pace != null && Number.isFinite(pace)
        ? `${Math.floor(pace / 60)}:${Math.round(pace % 60)
            .toString()
            .padStart(2, "0")}/km work pace`
        : "no work pace";
    const hr = r.avgWorkHr != null ? `, ${Math.round(Number(r.avgWorkHr))} bpm work HR` : "";
    return `- ${date}: ${km} km, ${r.workRepCount} reps, ${paceStr}${hr}`;
  });
  return lines.join("\n");
}

async function resolveReadiness(clerkUserId: string, date: string): Promise<ReadinessSignals> {
  const [day, summary] = await Promise.all([
    fetchFitnessDayBlock(clerkUserId, date).catch(() => null),
    fetchTrainingSummary(clerkUserId).catch(() => null),
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

export async function suggestSession(
  db: Db,
  userId: string,
  clerkUserId: string,
  input: { structureId?: number; structure?: WorkoutSet[]; date?: string; weather?: Weather },
  logger: Logger,
): Promise<SuggestSessionResponse> {
  const date = input.date ?? toISODate(new Date());
  const log = logger.child({ route: "suggest-session", date, structureId: input.structureId });

  let baseStructure: WorkoutSet[] | null = input.structure ?? null;
  let structureName: string | null = null;

  if (input.structureId != null) {
    const stored = await structureRepo.getStructureWithSets(db, userId, input.structureId);
    if (!stored) throw new AppError(404, "Interval structure not found");
    structureName = stored.name;
    if (!stored.sets || stored.sets.length === 0) {
      throw new AppError(
        422,
        "This saved structure has no stored workout shape yet — pass an explicit `structure` instead.",
      );
    }
    baseStructure = stored.sets;
  }

  if (!baseStructure || baseStructure.length === 0) {
    throw new AppError(400, "Provide either structureId or a non-empty structure.");
  }

  const key = cacheKey(userId, date, input.structureId, baseStructure, input.weather);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    log.info("suggest-session cache hit");
    return hit.value;
  }

  const readiness = await resolveReadiness(clerkUserId, date);
  const basePaces = await getProposedPaceForStructure(db, userId, clerkUserId, baseStructure);
  const { paces, advisory } = applyReadinessAdjustment(basePaces, readiness);
  const historySummary = await buildHistorySummary(db, userId, input.structureId);

  const suggestion = await invokeSuggestSessionAgent({
    date,
    baseStructure,
    structureName,
    historySummary,
    readiness,
    advisory,
  });

  let finalSets = baseStructure;
  let finalPaces = paces;
  let title = structureName ?? "Suggested session";
  let trainingType: ProposedTraining["trainingType"] = null;

  if (suggestion && suggestion.structure.length > 0) {
    finalSets = suggestion.structure;
    title = suggestion.title;
    trainingType = suggestion.trainingType ?? null;
    const reshapedBase = await getProposedPaceForStructure(db, userId, clerkUserId, finalSets);
    finalPaces = applyReadinessAdjustment(reshapedBase, readiness).paces;
  } else {
    log.warn("suggest-session agent returned null — using the athlete's own structure unchanged");
  }

  let heatAdvisory = "";
  if (input.weather) {
    const heat = applyHeatAdjustment(finalPaces, input.weather, heatZoneForTrainingType(trainingType));
    finalPaces = heat.paces;
    heatAdvisory = heat.advisory;
  }

  const combinedAdvisory = [advisory, heatAdvisory].filter(Boolean).join(" ");
  const notes: string | null = suggestion?.notes || combinedAdvisory || null;

  const proposedTraining: ProposedTraining = {
    type: "proposed_training",
    id: crypto.randomUUID(),
    title,
    trainingType,
    notes,
    structure: toWorkoutStructure(finalSets, finalPaces),
  };

  const sampledPaces = proposedTraining.structure
    .flatMap((s) => s.steps.map((st) => fmtPaceSecPerKm(st.target_pace)))
    .filter((p) => p !== "n/a");
  log.info(
    { hasSuggestion: !!suggestion, advisory: advisory.length > 0, samplePaces: sampledPaces },
    "suggest-session built",
  );

  const value: SuggestSessionResponse = {
    proposedTraining,
    paces: finalPaces,
    readiness,
    advisory: combinedAdvisory,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
