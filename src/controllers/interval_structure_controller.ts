import * as intervalStructureRepo from "../repositories/interval_structure_repository";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** The distinct interval structures the user has used, for filter pickers. */
export function listUsedStructures(db: Db, userId: string) {
  return intervalStructureRepo.listDistinctForUser(db, userId);
}
