import type { z } from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import type { WorkoutStructureSet } from "../schemas/agent_schemas";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";

type WorkoutSet = z.infer<typeof workoutSet>;

/**
 * Collapse the per-rep expanded paces (`paced`) back onto the compact
 * sets/steps shape. `target_pace` stays the mean of a step's per-rep paces
 * (frozen shape for existing consumers); `target_paces` additionally carries
 * the per-rep values in rep order so a negative-split progression can be shown.
 */
export function toWorkoutStructure(
  sets: WorkoutSet[],
  paced: ExpandedIntervalSet[] | null,
): WorkoutStructureSet[] {
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
        target_paces: paces.length > 0 ? paces.map((p) => Math.round(p * 100) / 100) : null,
      };
    });
    return { set_reps: set.set_reps, set_recovery: set.set_recovery ?? null, steps };
  });
}
