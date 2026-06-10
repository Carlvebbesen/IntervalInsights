import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { CoachArtifact } from "../../schemas/api_schemas";

const overwrite = <T>(_a: T, b: T): T => b;

const appendOrResetArtifacts = (
  existing: CoachArtifact[],
  update: CoachArtifact[] | null,
): CoachArtifact[] => (update === null ? [] : [...existing, ...update]);

export type Verdict = "pass" | "regenerate" | "blocked" | null;

export const TrainingStateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  verifyAttempts: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  verifyFeedback: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  finalAnswer: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  verdict: Annotation<Verdict>({ reducer: overwrite, default: () => null }),
  blocked: Annotation<boolean>({ reducer: overwrite, default: () => false }),
  pendingArtifacts: Annotation<CoachArtifact[], CoachArtifact[] | null>({
    reducer: appendOrResetArtifacts,
    default: () => [],
  }),
});

export type TrainingState = typeof TrainingStateAnnotation.State;
export type TrainingUpdate = typeof TrainingStateAnnotation.Update;
