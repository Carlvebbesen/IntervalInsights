import { AppError } from "../error";
import * as userRepo from "../repositories/user_repository";
import type { UserRole } from "../schema/enums";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** Set a user's role in the DB (source of truth for identity/role). */
export async function setUserRole(
  db: Db,
  targetUserId: string,
  role: UserRole,
): Promise<{ id: string; role: UserRole }> {
  const updated = await userRepo.updateById(db, targetUserId, { role });
  if (!updated) {
    throw new AppError(404, "User not found");
  }

  return { id: updated.id, role };
}
