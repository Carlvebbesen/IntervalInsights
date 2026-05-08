import type { z } from "zod";
import type { workoutStep } from "../agent/initial_analysis_agent";
export type ExpandedIntervalStep = Pick<
  z.infer<typeof workoutStep>,
  "work_type" | "work_value" | "recovery_value" | "recovery_type"
> & {
  target_pace: number | null;
};
export type ExpandedIntervalSet = {
  set_recovery?: number | null;
  steps: ExpandedIntervalStep[];
};
