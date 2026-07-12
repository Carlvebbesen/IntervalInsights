import type { z } from "zod";
import {
  reconcileIntervalSubtype,
  type WorkoutAnalysisOutput,
  type workoutSet,
} from "../agent/initial_analysis_agent";
import { invokeParseIntervalsAgent } from "../agent/parse_intervals_agent";
import { logger } from "../logger";
import type { TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import { generateCompleteIntervalSet, needCompleteAnalysis } from "./utils";

type WorkoutSet = z.infer<typeof workoutSet>;

const X_ADJACENT = /\d\s*[x×]\s*\(?\s*\d/i;
const WORK_REST = /\d+\s*\/\s*\d+/;
const COMMA_LIST_UNIT = /\d+\s*,\s*\d+(?:\s*,\s*\d+)*\s*(?:km|min|sek|sec|m|s)\b/i;
const N_OF_M = /\d+\s+(?:of|av)\s+\d+/i;
const BLOCK_CHAIN = /(?:etterfulgt av|deretter|followed by|then\b)/i;

export function looksStructured(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  if (X_ADJACENT.test(t)) return true;
  if (WORK_REST.test(t)) return true;
  if (COMMA_LIST_UNIT.test(t)) return true;
  if (N_OF_M.test(t)) return true;
  if (BLOCK_CHAIN.test(t) && /\d/.test(t)) return true;
  return false;
}

export async function extractDeclaredStructure(
  texts: (string | null | undefined)[],
  trainingType: TrainingType | null | undefined,
): Promise<WorkoutSet[] | null> {
  const structured = texts.filter((t): t is string => looksStructured(t));
  if (structured.length === 0) return null;
  try {
    const result = await invokeParseIntervalsAgent(structured.join("\n"), trainingType ?? null);
    const sets = result?.sets ?? [];
    return sets.length > 0 ? sets : null;
  } catch (err) {
    logger.warn({ err }, "extractDeclaredStructure: parse failed — ignoring text gate");
    return null;
  }
}

const N_OF_M_COMPLETION = /(\d+)\s+(?:av|of)\s+(\d+)/i;

export function applyPartialCompletion(
  notes: string | null | undefined,
  userSets: ExpandedIntervalSet[],
): ExpandedIntervalSet[] | null {
  if (!notes) return null;
  const match = notes.match(N_OF_M_COMPLETION);
  if (!match) return null;
  const n = Number(match[1]);
  const m = Number(match[2]);
  const totalSteps = userSets.reduce((acc, s) => acc + s.steps.length, 0);
  if (n <= 0 || m !== totalSteps || n >= m) return null;

  const result: ExpandedIntervalSet[] = [];
  let remaining = n;
  for (const set of userSets) {
    if (remaining <= 0) break;
    const kept = set.steps.slice(0, remaining);
    remaining -= kept.length;
    if (kept.length > 0) result.push({ ...set, steps: kept });
  }
  return result;
}

function stepsEqual(a: WorkoutSet["steps"][number], b: WorkoutSet["steps"][number]): boolean {
  return (
    a.reps === b.reps &&
    a.work_type === b.work_type &&
    a.work_value === b.work_value &&
    (a.recovery_type ?? null) === (b.recovery_type ?? null) &&
    (a.recovery_value ?? null) === (b.recovery_value ?? null)
  );
}

function structuresEqual(
  a: WorkoutSet[] | null | undefined,
  b: WorkoutSet[] | null | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i].set_reps !== y[i].set_reps) return false;
    if ((x[i].set_recovery ?? null) !== (y[i].set_recovery ?? null)) return false;
    if (x[i].steps.length !== y[i].steps.length) return false;
    for (let j = 0; j < x[i].steps.length; j++) {
      if (!stepsEqual(x[i].steps[j], y[i].steps[j])) return false;
    }
  }
  return true;
}

function classifyFromDeclared(declared: WorkoutSet[]): "SHORT_INTERVALS" | "LONG_INTERVALS" {
  for (const set of declared) {
    for (const step of set.steps) {
      if (step.work_type === "DISTANCE" ? step.work_value >= 800 : step.work_value >= 120) {
        return "LONG_INTERVALS";
      }
    }
  }
  return "SHORT_INTERVALS";
}

export function reconcileStructureTowardDeclared(
  model: WorkoutAnalysisOutput,
  declared: WorkoutSet[],
): { result: WorkoutAnalysisOutput; changed: boolean } {
  const modelStructure = model.structure ?? [];
  const aligned =
    modelStructure.length === declared.length &&
    declared.every((set, i) => set.steps.length === modelStructure[i].steps.length);

  const newStructure: WorkoutSet[] = aligned
    ? declared.map((set, i) => {
        const modelSet = modelStructure[i];
        return {
          set_reps: set.set_reps,
          set_recovery: set.set_recovery || modelSet.set_recovery,
          steps: set.steps.map((step, j) => {
            const modelStep = modelSet.steps[j];
            const declaredRecovery = (step.recovery_value ?? 0) > 0;
            return {
              reps: step.reps,
              work_type: step.work_type,
              work_value: step.work_value,
              recovery_type: declaredRecovery ? step.recovery_type : modelStep.recovery_type,
              recovery_value: declaredRecovery ? step.recovery_value : modelStep.recovery_value,
            };
          }),
        };
      })
    : declared;

  let trainingType = model.training_type;
  if (trainingType === "SHORT_INTERVALS" || trainingType === "LONG_INTERVALS") {
    trainingType = reconcileIntervalSubtype({
      ...model,
      structure: newStructure,
    }).training_type;
  } else if (!needCompleteAnalysis(trainingType)) {
    trainingType = classifyFromDeclared(newStructure);
  }

  const changed =
    trainingType !== model.training_type || !structuresEqual(modelStructure, newStructure);

  return {
    result: { ...model, structure: newStructure, training_type: trainingType },
    changed,
  };
}

export function rebuildSetsWithDeclaredPaces(
  declared: WorkoutSet[],
  previous: ExpandedIntervalSet[],
): ExpandedIntervalSet[] {
  const prevPaces = previous.flatMap((s) => s.steps.map((st) => st.target_pace ?? null));
  const rebuilt = generateCompleteIntervalSet(declared) as ExpandedIntervalSet[];
  let idx = 0;
  for (const set of rebuilt) {
    for (const step of set.steps) {
      step.target_pace = idx < prevPaces.length ? prevPaces[idx] : null;
      idx++;
    }
  }
  return rebuilt;
}
