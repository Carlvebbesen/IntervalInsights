import { eq } from "drizzle-orm";
import { activities, intervalStructures } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** Repository for the `interval_structures` table. */

/** Distinct interval structures the user has at least one activity linked to. */
export function listDistinctForUser(db: Db, userId: string) {
  return db
    .selectDistinct({
      id: intervalStructures.id,
      name: intervalStructures.name,
      signature: intervalStructures.signature,
    })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .where(eq(activities.userId, userId));
}
