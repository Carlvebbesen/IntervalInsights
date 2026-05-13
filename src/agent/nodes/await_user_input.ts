import { interrupt } from "@langchain/langgraph";
import { logger } from "../../logger";
import type { TrainingType } from "../../schema/enums";
import { generateCompleteIntervalSet } from "../../services.ts/utils";
import type { ExpandedIntervalSet } from "../../types/ExpandedIntervalSet";
import type { AnalysisState } from "../graph_state";

export async function awaitUserInput(state: AnalysisState): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "awaitUserInput", activityId: state.activityId });
  log.info("entering interrupt (or resuming with payload)");
  const userInput = interrupt({
    initialResult: state.initialResult,
    activityId: state.activityId,
  }) as {
    notes: string;
    sets: ExpandedIntervalSet[];
    trainingType: string | null;
    feeling?: number | null;
  };

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
    confirmedTrainingType: (userInput.trainingType as TrainingType | null) ?? null,
    feeling: userInput.feeling ?? null,
  };
}
