import type { z } from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { invokeSuggestSessionAgent } from "../agent/suggest_session_agent";
import { AppError } from "../error";
import type { Logger } from "../logger";
import * as structureRepo from "../repositories/interval_structure_repository";
import * as planRepo from "../repositories/training_plan_repository";
import type { TrainingType } from "../schema/enums";
import type { WorkoutStructureSet } from "../schemas/agent_schemas";
import type {
  ProposedTrainingArtifactSchema,
  SuggestSessionResponseSchema,
  Weather,
} from "../schemas/api_schemas";
import type { IGlobalBindings } from "../types/IRouters";
import { buildAthleteProfileBlock } from "./athlete_profile_service";
import { applyHeatAdjustment, heatZoneForTrainingType } from "./heat_service";
import { computeAdjustedPace, resolveReadiness } from "./prescription_pace_service";
import { addDaysISO, toISODate } from "./utils";
import { toWorkoutStructure } from "./workout_structure_format";

type Db = IGlobalBindings["db"];
type WorkoutSet = z.infer<typeof workoutSet>;
type SuggestSessionResponse = z.infer<typeof SuggestSessionResponseSchema>;
type ProposedTraining = z.infer<typeof ProposedTrainingArtifactSchema>;
type SuggestionMode = "signature" | "recommended";
export type RequestMode = "plan" | "signature" | "ai";
type ResponseMode = "plan" | "signature" | "ai";

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
  mode: ResponseMode,
  recentlySuggested: string[],
  plannedSessionId: number | null,
): string {
  const shape =
    plannedSessionId != null
      ? `ps:${plannedSessionId}`
      : structureId != null
        ? `id:${structureId}`
        : `h:${hashStructure(sets)}`;
  const w = weather ? `|w:${Math.round(weather.temperatureC)}:${Math.round(weather.humidity)}` : "";
  const r = recentlySuggested.length > 0 ? `|r:${recentlySuggested.join("~")}` : "";
  return `${userId}|${date}|${shape}|m:${mode}${w}${r}`;
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

type WorkoutStep = WorkoutSet["steps"][number];

const MAX_TRUSTED_REST_S = 600;

function cleanRest(seconds: number | null): number | null {
  if (seconds == null || seconds > MAX_TRUSTED_REST_S) return null;
  if (seconds <= 2) return 0;
  return Math.round(seconds / 5) * 5;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function setsFromSegments(
  rows: Awaited<ReturnType<typeof structureRepo.representativeIntervalSegments>>,
): WorkoutSet[] {
  const mapType = (t: string | null): "TIME" | "DISTANCE" | null =>
    t === "time" ? "TIME" : t === "distance" ? "DISTANCE" : null;

  type Seg = {
    setGroupIndex: number;
    workType: "TIME" | "DISTANCE";
    workValue: number;
    recoveryType: "TIME" | "DISTANCE" | null;
    recoveryValue: number | null;
  };
  const isWork = (r: (typeof rows)[number]) =>
    r.type === "INTERVALS" && mapType(r.targetType) != null && !!r.targetValue;
  const isRest = (r: (typeof rows)[number]) => r.type === "REST" || r.type === "ACTIVE_REST";

  const segs: Seg[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isWork(r)) continue;

    let j = i + 1;
    while (j < rows.length && !isWork(rows[j])) j++;
    const next = j < rows.length ? rows[j] : null;

    let restValue: number | null = null;
    let restType: "TIME" | "DISTANCE" | null = null;
    if (next != null) {
      if (r.recoveryTargetValue != null) {
        restValue = r.recoveryTargetValue;
        restType = mapType(r.recoveryTargetType) ?? "TIME";
      } else {
        for (let k = i + 1; k < j; k++) {
          const rr = rows[k];
          if (isRest(rr) && rr.targetValue && mapType(rr.targetType) != null) {
            restValue = rr.targetValue;
            restType = mapType(rr.targetType);
            break;
          }
        }
        if (restValue == null) {
          restValue = cleanRest(next.timeSeriesEndTime - next.actualDuration - r.timeSeriesEndTime);
          restType = restValue == null ? null : "TIME";
        }
      }
    }

    segs.push({
      setGroupIndex: r.setGroupIndex,
      workType: mapType(r.targetType) as "TIME" | "DISTANCE",
      workValue: r.targetValue,
      recoveryType: restValue == null ? null : restType,
      recoveryValue: restValue,
    });
  }

  const groups: Seg[][] = [];
  for (const s of segs) {
    const g = groups[groups.length - 1];
    if (g && g[0].setGroupIndex === s.setGroupIndex) g.push(s);
    else groups.push([s]);
  }

  type Group = { steps: WorkoutStep[]; setRecovery: number | null };
  const built: Group[] = groups
    .map((segsInGroup) => {
      const setRecovery = segsInGroup[segsInGroup.length - 1].recoveryValue;
      const innerRecoveries = new Map<number, number[]>();
      const steps: WorkoutStep[] = [];
      for (let i = 0; i < segsInGroup.length; i++) {
        const s = segsInGroup[i];
        const isLast = i === segsInGroup.length - 1;
        const prev = steps[steps.length - 1];
        let stepIdx: number;
        if (prev && prev.work_type === s.workType && prev.work_value === s.workValue) {
          prev.reps += 1;
          stepIdx = steps.length - 1;
        } else {
          steps.push({
            reps: 1,
            work_type: s.workType,
            work_value: s.workValue,
            recovery_type: null,
            recovery_value: null,
          });
          stepIdx = steps.length - 1;
        }
        if (!isLast && s.recoveryValue != null) {
          const list = innerRecoveries.get(stepIdx) ?? [];
          list.push(s.recoveryValue);
          innerRecoveries.set(stepIdx, list);
        }
      }
      steps.forEach((step, idx) => {
        const rec = median(innerRecoveries.get(idx) ?? []);
        if (rec != null) {
          step.recovery_value = rec;
          step.recovery_type = "TIME";
        }
      });
      return { steps, setRecovery };
    })
    .filter((g) => g.steps.length > 0);

  const sameSteps = (a: WorkoutStep[], b: WorkoutStep[]) =>
    a.length === b.length &&
    a.every(
      (s, i) =>
        s.work_type === b[i].work_type &&
        s.work_value === b[i].work_value &&
        s.reps === b[i].reps &&
        s.recovery_value === b[i].recovery_value,
    );

  const sets: WorkoutSet[] = [];
  const groupRests: number[][] = [];
  for (const g of built) {
    const last = sets[sets.length - 1];
    if (last && sameSteps(last.steps, g.steps)) {
      last.set_reps += 1;
      if (g.setRecovery != null) groupRests[groupRests.length - 1].push(g.setRecovery);
    } else {
      sets.push({ set_reps: 1, set_recovery: null, steps: g.steps });
      groupRests.push(g.setRecovery != null ? [g.setRecovery] : []);
    }
  }
  sets.forEach((set, i) => {
    set.set_recovery = median(groupRests[i]);
  });
  return sets;
}

async function buildTrainingHistorySummary(db: Db, userId: string): Promise<string> {
  const rows = await structureRepo.listDistinctForUser(db, userId);
  if (rows.length === 0) return "";
  const recent = rows.slice(0, 8);
  const lines = recent.map((r) => {
    const last = r.lastDoneAt ? new Date(r.lastDoneAt).toISOString().slice(0, 10) : "unknown";
    return `- ${r.name}: done ${r.activityCount}x, last on ${last}`;
  });
  return lines.join("\n");
}

function writeCache(key: string, value: SuggestSessionResponse): void {
  const nowMs = Date.now();
  for (const [staleKey, entry] of cache) {
    if (nowMs - entry.at >= CACHE_TTL_MS) cache.delete(staleKey);
  }
  cache.set(key, { at: nowMs, value });
}

/** Drop the pace fields from a stored plan structure to get the pace-agnostic input shape. */
function structureToWorkoutSets(structure: WorkoutStructureSet[]): WorkoutSet[] {
  return structure.map((set) => ({
    set_reps: set.set_reps,
    set_recovery: set.set_recovery ?? null,
    steps: set.steps.map((step) => ({
      reps: step.reps,
      work_type: step.work_type,
      work_value: step.work_value,
      recovery_type: step.recovery_type ?? null,
      recovery_value: step.recovery_value ?? null,
    })),
  }));
}

interface ResolvedRequestMode {
  mode: ResponseMode;
  due: planRepo.DuePlannedSession | null;
}

async function resolveRequestMode(
  db: Db,
  userId: string,
  requested: RequestMode | undefined,
  date: string,
  role: SuggestSessionRole,
  hasExplicitStructure: boolean,
): Promise<ResolvedRequestMode> {
  if (requested === "signature" || requested === "ai") return { mode: requested, due: null };

  // An explicit structureId or inline structure is a signature-shaped request:
  // only an explicit mode "plan" may override it. Auto used to hijack it onto a
  // due planned session — and 422 when that session was an unstructured easy run.
  if (requested == null && hasExplicitStructure) return { mode: "signature", due: null };

  // This endpoint is deliberately free for all users, but training plans are a
  // premium feature in whole — so the plan-reading branch (which returns planId,
  // plannedSessionId, title, description and the full structure) must carry the
  // same gate the /training-plans routers do. A downgraded user simply has no
  // session due: explicit mode "plan" 404s exactly as it would with no plan, and
  // auto falls through to the free signature path.
  const canReadPlan = role === "premium" || role === "admin";
  const tomorrow = addDaysISO(date, 1);
  const due = canReadPlan ? await planRepo.findDuePlannedSession(db, userId, date, tomorrow) : null;

  if (requested === "plan") {
    if (!due) {
      throw new AppError(404, "No planned session is due today or tomorrow in an active plan.");
    }
    return { mode: "plan", due };
  }
  // auto: plan when a due session can actually seed a suggestion; an
  // unstructured due session (e.g. a plain easy run) falls back to the
  // signature path instead of 422-ing (the 422 stays for explicit mode "plan").
  if (due && (due.session.structure ?? []).length > 0) return { mode: "plan", due };
  return { mode: "signature", due: null };
}

async function buildPlanSuggestion(
  db: Db,
  userId: string,
  due: planRepo.DuePlannedSession,
  date: string,
  weather: Weather | undefined,
  log: Logger,
): Promise<SuggestSessionResponse> {
  const session = due.session;
  const structure = session.structure ?? [];
  if (structure.length === 0) {
    throw new AppError(
      422,
      "This planned session has no structured workout to build a suggestion from.",
    );
  }
  const sets = structureToWorkoutSets(structure);
  const sessionType = session.sessionType as TrainingType;

  const readiness = await resolveReadiness(db, userId, date);
  const { paces: finalPaces, advisory: combinedAdvisory } = await computeAdjustedPace(db, userId, {
    sets,
    sessionType,
    readiness,
    weather,
  });

  const notes: string | null = session.description || combinedAdvisory || null;

  const proposedTraining: ProposedTraining = {
    type: "proposed_training",
    id: crypto.randomUUID(),
    title: session.title,
    trainingType: sessionType,
    notes,
    structure: toWorkoutStructure(sets, finalPaces),
  };

  log.info(
    { plannedSessionId: session.id, planId: due.planId },
    "suggest-session built from planned session (plan mode)",
  );

  return {
    proposedTraining,
    paces: finalPaces,
    readiness,
    advisory: combinedAdvisory,
    mode: "plan",
    plannedSessionId: session.id,
    planId: due.planId,
  };
}

export type SuggestSessionRole = "guest" | "premium" | "admin";

export async function suggestSession(
  db: Db,
  userId: string,
  role: SuggestSessionRole,
  input: {
    structureId?: number;
    structure?: WorkoutSet[];
    date?: string;
    weather?: Weather;
    mode?: RequestMode;
    recentlySuggested?: string[];
  },
  logger: Logger,
): Promise<SuggestSessionResponse> {
  const now = new Date();
  const date = input.date ?? toISODate(now);
  const recentlySuggested = input.recentlySuggested ?? [];

  const resolved = await resolveRequestMode(
    db,
    userId,
    input.mode,
    date,
    role,
    input.structureId != null || (input.structure?.length ?? 0) > 0,
  );
  const log = logger.child({
    route: "suggest-session",
    date,
    structureId: input.structureId,
    mode: resolved.mode,
  });

  if (resolved.mode === "plan" && resolved.due) {
    const plannedSessionId = resolved.due.session.id;
    const key = cacheKey(userId, date, undefined, [], input.weather, "plan", [], plannedSessionId);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      log.info("suggest-session cache hit");
      return hit.value;
    }
    const value = await buildPlanSuggestion(db, userId, resolved.due, date, input.weather, log);
    writeCache(key, value);
    return value;
  }

  // signature / ai: the athlete-driven LLM path.
  const agentMode: SuggestionMode = resolved.mode === "ai" ? "recommended" : "signature";
  let baseStructure: WorkoutSet[] | null = input.structure ?? null;
  let structureName: string | null = null;

  if (input.structureId != null) {
    const stored = await structureRepo.getStructureWithSets(db, userId, input.structureId);
    if (!stored) throw new AppError(404, "Interval structure not found");
    structureName = stored.name;
    let sets = stored.sets;
    if (!sets || sets.length === 0) {
      const segRows = await structureRepo.representativeIntervalSegments(
        db,
        userId,
        input.structureId,
      );
      const reconstructed = setsFromSegments(segRows);
      if (reconstructed.length > 0) {
        log.info({ setCount: reconstructed.length }, "reconstructed structure shape from segments");
        sets = reconstructed;
      }
    }
    if (!sets || sets.length === 0) {
      throw new AppError(
        422,
        "This saved structure has no stored workout shape yet — pass an explicit `structure` instead.",
      );
    }
    baseStructure = sets;
  }

  if (!baseStructure || baseStructure.length === 0) {
    throw new AppError(400, "Provide either structureId or a non-empty structure.");
  }

  const key = cacheKey(
    userId,
    date,
    input.structureId,
    baseStructure,
    input.weather,
    resolved.mode,
    recentlySuggested,
    null,
  );
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    log.info("suggest-session cache hit");
    return hit.value;
  }

  const readiness = await resolveReadiness(db, userId, date);
  const { paces, advisory } = await computeAdjustedPace(db, userId, {
    sets: baseStructure,
    sessionType: null,
    readiness,
  });
  const [historySummary, athleteProfile] = await Promise.all([
    agentMode === "recommended"
      ? buildTrainingHistorySummary(db, userId)
      : buildHistorySummary(db, userId, input.structureId),
    buildAthleteProfileBlock(db, userId, now).catch(() => ""),
  ]);

  const suggestion = await invokeSuggestSessionAgent({
    date,
    baseStructure,
    structureName,
    historySummary,
    athleteProfile,
    recentlySuggested,
    readiness,
    advisory,
    mode: agentMode,
  });

  let finalSets = baseStructure;
  let finalPaces = paces;
  let title = structureName ?? "Suggested session";
  let trainingType: ProposedTraining["trainingType"] = null;

  if (suggestion && suggestion.structure.length > 0) {
    finalSets = suggestion.structure;
    title = suggestion.title;
    trainingType = suggestion.trainingType ?? null;
    finalPaces = (
      await computeAdjustedPace(db, userId, {
        sets: finalSets,
        sessionType: trainingType,
        readiness,
      })
    ).paces;
  } else {
    log.warn("suggest-session agent returned null — using the athlete's own structure unchanged");
  }

  let heatAdvisory = "";
  if (input.weather) {
    const heat = applyHeatAdjustment(
      finalPaces,
      input.weather,
      heatZoneForTrainingType(trainingType),
    );
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
    mode: resolved.mode,
    plannedSessionId: null,
    planId: null,
  };
  writeCache(key, value);
  return value;
}
