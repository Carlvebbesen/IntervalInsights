import { auth } from "../auth";
import { AppError } from "../error";
import type { UserDao } from "../repositories/user_repository";
import * as userRepo from "../repositories/user_repository";
import type { UserRole } from "../schema/enums";
import type { AdminUserRow } from "../schemas/admin_schemas";
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

export function getStats(db: Db): Promise<userRepo.UserStats> {
  return userRepo.getUserStats(db);
}

function toRow(user: UserDao): AdminUserRow {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role ?? "guest",
    banned: user.banned,
    banReason: user.banReason,
    createdAt: user.createdAt?.toISOString() ?? null,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
  };
}

export async function listUsers(
  db: Db,
  params: userRepo.ListUsersParams,
): Promise<{ data: AdminUserRow[]; meta: userRepo.ListUsersResult["meta"] }> {
  const { data, meta } = await userRepo.listUsers(db, params);
  return { data: data.map(toRow), meta };
}

export async function setBanned(
  db: Db,
  headers: Headers,
  adminUserId: string,
  targetUserId: string,
  banned: boolean,
  reason?: string,
): Promise<{ id: string; banned: boolean; banReason: string | null }> {
  const target = await userRepo.findById(db, targetUserId);
  if (!target) {
    throw new AppError(404, "User not found");
  }
  if (target.id === adminUserId) {
    throw new AppError(403, "You cannot ban your own account");
  }
  if (target.role === "admin") {
    throw new AppError(403, "Admin users cannot be banned");
  }

  if (banned) {
    await auth.api.banUser({ headers, body: { userId: targetUserId, banReason: reason } });
  } else {
    await auth.api.unbanUser({ headers, body: { userId: targetUserId } });
  }

  const updated = await userRepo.findById(db, targetUserId);
  return { id: targetUserId, banned, banReason: updated?.banReason ?? null };
}
