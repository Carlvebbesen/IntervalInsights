import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { logger } from "../../logger";
import { trainingTypeEnum } from "../../schema/enums";
import { EditedSegmentSchema, ExpandedIntervalSetSchema } from "../../schemas/api_schemas";
import { progressService } from "../../services/progress_service";
import {
  applyPartialCompletion,
  extractDeclaredStructure,
  rebuildSetsWithDeclaredPaces,
} from "../../services/text_intent_service";
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
  editedSegments: z.array(EditedSegmentSchema).optional(),
});

export async function awaitUserInput(state: AnalysisState): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "awaitUserInput", activityId: state.activityId });
  log.info("entering interrupt (or resuming with payload)");

  // The draft + proposed segments both exist by now — signal the app the activity
  // is ready to review before parking at the interrupt. (Runs again on resume;
  // harmless — the app treats it as an idempotent pending refetch.)
  await progressService.publish(state.userId, {
    type: "progress",
    data: {
      id: state.activityId,
      kind: "analysis",
      phase: "ready_for_review",
      analysisStatus: "initial",
      title: state.activityTitle || undefined,
    },
  });

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

  // Notes beat title/description (newer + deliberate): if the resume-time notes
  // declare a structure ("only did 8 of 10"), rebuild userSets toward them,
  // carrying the previously-proposed paces over positionally. Generic/empty notes
  // fail the prefilter inside extractDeclaredStructure and cost no LLM call. Any
  // failure keeps the user's original sets.
  let structureSource: "model" | "text" | "notes" = state.structureSource ?? "model";
  try {
    // Try the deterministic "N of M" completion first (free, no LLM): the notes
    // name no distances/durations, so the parse agent correctly returns nothing —
    // "8 av 10" refers to the EXISTING structure. Only fall through to the parse
    // path when the notes declare a NEW structure.
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
