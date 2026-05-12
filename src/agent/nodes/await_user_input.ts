import { interrupt } from "@langchain/langgraph";
import type { TrainingType } from "../../schema/enums";
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

  console.log(
    `${tag} resumed notes.len=${userInput?.notes?.length ?? 0} sets=${userInput?.sets?.length ?? 0} trainingType=${userInput?.trainingType ?? "null"} feeling=${userInput?.feeling ?? "null"}`,
  );
  return {
    userNotes: userInput.notes ?? "",
    userSets: userInput.sets ?? [],
    confirmedTrainingType: (userInput.trainingType as TrainingType | null) ?? null,
    feeling: userInput.feeling ?? null,
  };
}
