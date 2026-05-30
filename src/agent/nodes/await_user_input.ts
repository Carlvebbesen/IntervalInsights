import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { logger } from "../../logger";
import { trainingTypeEnum } from "../../schema/enums";
import { ExpandedIntervalSetSchema } from "../../schemas/api_schemas";
import { generateCompleteIntervalSet } from "../../services/utils";
import type { ExpandedIntervalSet } from "../../types/ExpandedIntervalSet";
import type { AnalysisState } from "../graph_state";

// The resume payload is validated at the HTTP boundary (POST /agents/resume-analysis),
// but `interrupt()` returns `unknown`, so re-validate here rather than trusting a cast —
// a malformed/corrupted checkpoint payload should fail loudly, not corrupt the run.
const resumePayloadSchema = z.object({
  notes: z.string().optional(),
  sets: z.array(ExpandedIntervalSetSchema).optional(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  feeling: z.number().nullable().optional(),
});

export async function awaitUserInput(state: AnalysisState): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "awaitUserInput", activityId: state.activityId });
  log.info("entering interrupt (or resuming with payload)");
  const raw = interrupt({
    initialResult: state.initialResult,
    activityId: state.activityId,
  });

  const parsed = resumePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, "invalid resume payload");
    throw new Error(
      `Invalid resume payload for activity ${state.activityId}: ${parsed.error.message}`,
    );
  }
  const userInput = parsed.data;

  let userSets: ExpandedIntervalSet[] = userInput.sets ?? [];
  if (userSets.length === 0 && state.initialResult?.structure?.length) {
    userSets = generateCompleteIntervalSet(state.initialResult.structure);
    log.info({ sets: userSets.length }, "hydrated empty userSets from initialResult.structure");
  }

  log.info(
    {
      notesLen: userInput?.notes?.length ?? 0,
      sets: userSets.length,
      trainingType: userInput?.trainingType,
      feeling: userInput?.feeling,
    },
    "resumed",
  );
  return {
    userNotes: userInput.notes ?? "",
    userSets,
    confirmedTrainingType: userInput.trainingType ?? null,
    feeling: userInput.feeling ?? null,
  };
}
