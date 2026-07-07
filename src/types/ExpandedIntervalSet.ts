import type { z } from "zod";
import type {
  ExpandedIntervalSetSchema,
  ExpandedIntervalStepSchema,
} from "../schemas/agent_schemas";

export type ExpandedIntervalStep = z.infer<typeof ExpandedIntervalStepSchema>;
export type ExpandedIntervalSet = z.infer<typeof ExpandedIntervalSetSchema>;
