import type { z } from "zod";
import {
  reconcileIntervalSubtype,
  type WorkoutAnalysisOutput,
  type workoutSet,
} from "../agent/initial_analysis_agent";
import { invokeParseIntervalsAgent, type ParseWorkoutSet } from "../agent/parse_intervals_agent";
import { logger } from "../logger";
import type { TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import {
  generateCompleteIntervalSet,
  needCompleteAnalysis,
  parsePaceStringToMetersPerSecond,
} from "./utils";

type WorkoutSet = z.infer<typeof workoutSet>;

// A digit adjacent to x/× in either order ("10x1000m", "10 x 1000m", "6x6min"),
// tolerating an opening paren after the x ("5 x (3,2,1 min)").
const X_ADJACENT = /\d\s*[x×]\s*\(?\s*\d/i;
// Work/rest notation ("45/15", "90/30s").
const WORK_REST = /\d+\s*\/\s*\d+/;
// A comma-separated number LIST followed by a unit (Norwegian list notation):
// "3,2,1 km", "3,2,2 km" — a genuine rep sequence, not a lone distance.
const COMMA_LIST_UNIT = /\d+\s*,\s*\d+(?:\s*,\s*\d+)*\s*(?:km|min|sek|sec|m|s)\b/i;
// Partial-completion phrasing: "did 8 of 10", "8 av 10".
const N_OF_M = /\d+\s+(?:of|av)\s+\d+/i;
// Block-chain keywords that join distinct interval blocks. Only meaningful
// alongside digits (a chained workout always carries numbers).
const BLOCK_CHAIN = /(?:etterfulgt av|deretter|followed by|then\b)/i;

/**
 * Deterministic prefilter: could this text DECLARE a workout structure? Errs
 * slightly toward true (a false positive costs one mini-LLM parse; a false
 * negative silently ships the wrong structure), but generic titles ("Morning
 * Run", "Marathon training week 12") — anything without a rep-like arrangement of
 * numbers — must return false so they never reach the parse agent.
 */
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

/**
 * Flat, expanded list of declared work-step paces (m/s), one entry per expanded
 * WORK step in the exact order `generateCompleteIntervalSet` produces them — so it
 * lines up positionally with the expanded sets. A step with no explicitly-stated
 * pace maps to null (never inferred). Text-declared paces ONLY; converted via the
 * shared `parsePaceStringToMetersPerSecond` (garbage/ambiguous strings → null).
 */
export function expandDeclaredPaces(sets: ParseWorkoutSet[]): (number | null)[] {
  const paces: (number | null)[] = [];
  for (const set of sets) {
    for (let i = 0; i < set.set_reps; i++) {
      for (const step of set.steps) {
        const mps = parsePaceStringToMetersPerSecond(step.target_pace_string ?? null);
        for (let r = 0; r < step.reps; r++) paces.push(mps);
      }
    }
  }
  return paces;
}

/**
 * Override a proposed rep-list's paces with declared ones positionally: where a
 * declared pace exists for a work step, it wins; where it's null (no explicit
 * declaration for that step), the existing pace is left untouched. Expanding from
 * an all-null set therefore yields declared-only paces; expanding from a
 * lap/history proposal overrides only the declared positions.
 */
export function applyDeclaredPacesPositionally(
  sets: ExpandedIntervalSet[],
  declaredPaces: (number | null)[],
): ExpandedIntervalSet[] {
  let idx = 0;
  return sets.map((set) => ({
    ...set,
    steps: set.steps.map((step) => {
      const pace = idx < declaredPaces.length ? declaredPaces[idx] : null;
      idx++;
      return pace != null ? { ...step, target_pace: pace } : step;
    }),
  }));
}

/**
 * Text gate that ALSO surfaces explicitly-declared paces: returns the parsed sets
 * plus `declaredPaces` (flat, expanded, positional — see `expandDeclaredPaces`).
 * `declaredPaces` is all-null when the text stated no pace. Never throws.
 */
export async function extractDeclaredStructureWithPaces(
  texts: (string | null | undefined)[],
  trainingType: TrainingType | null | undefined,
): Promise<{ sets: ParseWorkoutSet[]; declaredPaces: (number | null)[] } | null> {
  const structured = texts.filter((t): t is string => looksStructured(t));
  if (structured.length === 0) return null;
  try {
    const result = await invokeParseIntervalsAgent(structured.join("\n"), trainingType ?? null);
    const sets = result?.sets ?? [];
    if (sets.length === 0) return null;
    return { sets, declaredPaces: expandDeclaredPaces(sets) };
  } catch (err) {
    logger.warn({ err }, "extractDeclaredStructure: parse failed — ignoring text gate");
    return null;
  }
}

export async function extractDeclaredStructure(
  texts: (string | null | undefined)[],
  trainingType: TrainingType | null | undefined,
): Promise<WorkoutSet[] | null> {
  const result = await extractDeclaredStructureWithPaces(texts, trainingType);
  return result?.sets ?? null;
}

// Partial-completion phrasing with capture groups: "8 av 10" (Norwegian), "8 of
// 10" (English). Deliberately NOT a bare slash ("8/10") — that collides with
// work/rest notation like "45/15".
const N_OF_M_COMPLETION = /(\d+)\s+(?:av|of)\s+(\d+)/i;

/**
 * Deterministic "did N of M" handler — zero LLM cost. When resume-time notes say
 * the athlete completed only the first N of M declared work steps ("klarte bare 8
 * av 10"), truncate `userSets` to those N steps. Applies ONLY when M equals the
 * current total work-step count and N < M (anything else is ambiguous or a no-op
 * → null). Walks sets in order, truncating step lists and dropping sets that
 * become empty, preserving each kept step's fields (incl. target_pace).
 */
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

/** Same hard gate as the classifier: any rep >= 120s or >= 800m ⇒ LONG. */
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

/**
 * Text wins on SHAPE. Adopt the declared structure over the model's: declared
 * set count, set_reps, per-step reps/work_type/work_value are authoritative. When
 * the model and declared align positionally (same set count and per-set step
 * count), carry the model's recovery values into steps the declared shape leaves
 * unspecified (declared recovery wins when present); otherwise take the declared
 * sets verbatim. Then fix training_type: interval subtypes re-run the existing
 * gate; a type that doesn't need complete analysis (e.g. the misclassify-EASY
 * failure mode) is reclassified deterministically from the declared reps; other
 * interval-family types keep their type.
 */
export function reconcileStructureTowardDeclared(
  model: WorkoutAnalysisOutput,
  declared: WorkoutSet[],
): { result: WorkoutAnalysisOutput; changed: boolean } {
  const modelStructure = model.structure ?? [];
  const aligned =
    modelStructure.length === declared.length &&
    declared.every((set, i) => set.steps.length === modelStructure[i].steps.length);

  // The parse agent emits recovery_value 0 / set_recovery 0 (not null) when the
  // text says nothing about recovery, so 0 means "unspecified" — keep the model's
  // measured recovery in that case, and take the pair together so a declared
  // value never merges with a model type (or vice versa).
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

/**
 * Rebuild the user's expanded set list from a notes-declared structure, carrying
 * each previous work step's target_pace over positionally (flatten both to step
 * lists, copy by index while an index exists; extra steps keep null pace).
 */
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
