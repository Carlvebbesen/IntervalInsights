import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { logger } from "../../logger";
import { trainingTypeEnum } from "../../schema/enums";
import { EditedSegmentSchema, ExpandedIntervalSetSchema } from "../../schemas/api_schemas";
import {
  applyPartialCompletion,
  extractDeclaredStructure,
  rebuildSetsWithDeclaredPaces,
} from "../../services/text_intent_service";
import { generateCompleteIntervalSet } from "../../services/utils";
import type { ExpandedIntervalSet } from "../../types/ExpandedIntervalSet";
import type { AnalysisState } from "../graph_state";

const resumePayloadSchema = z.object({
  notes: z.string().optional(),
  sets: z.array(ExpandedIntervalSetSchema).optional(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  feeling: z.number().nullable().optional(),
  editedSegments: z.array(EditedSegmentSchema).optional(),
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

  const confirmedTrainingType = userInput.trainingType ?? null;

  let structureSource: "model" | "text" | "notes" = state.structureSource ?? "model";
  try {
    const partial = applyPartialCompletion(userInput.notes, userSets);
    if (partial) {
      const prevWorkSteps = userSets.reduce((n, s) => n + s.steps.length, 0);
      userSets = partial;
      const newWorkSteps = userSets.reduce((n, s) => n + s.steps.length, 0);
      structureSource = "notes";
      log.info(
        { prevWorkSteps, newWorkSteps },
        "notes reported partial completion — userSets truncated to completed steps",
      );
    } else {
      const notesDeclared = await extractDeclaredStructure(
        [userInput.notes],
        confirmedTrainingType ?? state.initialResult?.training_type,
      );
      if (notesDeclared) {
        const prevWorkSteps = userSets.reduce((n, s) => n + s.steps.length, 0);
        userSets = rebuildSetsWithDeclaredPaces(notesDeclared, userSets);
        const newWorkSteps = userSets.reduce((n, s) => n + s.steps.length, 0);
        structureSource = "notes";
        log.info(
          { prevWorkSteps, newWorkSteps },
          "notes declared a structure — userSets rebuilt toward notes",
        );
      }
    }
  } catch (err) {
    log.warn({ err }, "notes reconciliation failed — keeping user sets");
  }

  log.info(
    {
      notesLen: userInput?.notes?.length ?? 0,
      sets: userSets.length,
      trainingType: userInput?.trainingType,
      feeling: userInput?.feeling,
      editedSegments: userInput.editedSegments?.length ?? 0,
    },
    "resumed",
  );
  return {
    userNotes: userInput.notes ?? "",
    userSets,
    confirmedTrainingType,
    feeling: userInput.feeling ?? null,
    userEditedSegments: userInput.editedSegments ?? [],
    structureSource,
  };
}
