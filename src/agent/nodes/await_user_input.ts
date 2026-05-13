import { interrupt } from "@langchain/langgraph";
import type { TrainingType } from "../../schema/enums";
import { generateCompleteIntervalSet } from "../../services.ts/utils";
import type { ExpandedIntervalSet } from "../../types/ExpandedIntervalSet";
import type { AnalysisState } from "../graph_state";

export async function awaitUserInput(state: AnalysisState): Promise<Partial<AnalysisState>> {
  const tag = `[awaitUserInput activity=${state.activityId}]`;
  console.log(`${tag} entering interrupt (or resuming with payload)`);
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
    console.log(
      `${tag} hydrated empty userSets from initialResult.structure -> ${userSets.length} set(s)`,
    );
  }

  console.log(
    `${tag} resumed notes.len=${userInput?.notes?.length ?? 0} sets=${userSets.length} trainingType=${userInput?.trainingType ?? "null"} feeling=${userInput?.feeling ?? "null"}`,
  );
  return {
    userNotes: userInput.notes ?? "",
    userSets,
    confirmedTrainingType: (userInput.trainingType as TrainingType | null) ?? null,
    feeling: userInput.feeling ?? null,
  };
}
