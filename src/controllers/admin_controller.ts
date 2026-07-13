import { AppError } from "../error";
import * as userRepo from "../repositories/user_repository";
import type { UserRole } from "../schema/enums";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export async function setUserRole(
  db: Db,
  targetUserId: string,
  role: UserRole,
): Promise<{ id: string; role: UserRole }> {
  if (role === "admin") {
    throw new AppError(403, "The admin role can only be granted by a direct database update");
  }

  const target = await userRepo.findById(db, targetUserId);
  if (!target) {
    throw new AppError(404, "User not found");
  }
  if (target.role === "admin") {
    throw new AppError(403, "Admin users can only be modified by a direct database update");
  }

  const updated = await userRepo.updateById(db, targetUserId, { role });
  if (!updated) {
    throw new AppError(404, "User not found");
  }

  return { id: updated.id, role };
}
