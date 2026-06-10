import { AppError } from "../../../error";
import * as activityRepo from "../../../repositories/activity_repository";
import { toISODate } from "../../../services/utils";
import type { CoachCtx } from "../tool_types";

export function ctxNow(ctx: CoachCtx): Date {
  const d = new Date(ctx.userTime);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function ctxToday(ctx: CoachCtx): string {
  return toISODate(ctxNow(ctx));
}

export function isoDaysAgo(ctx: CoachCtx, days: number): string {
  return toISODate(new Date(ctxNow(ctx).getTime() - days * 86_400_000));
}

export async function resolveOwnedActivity(ctx: CoachCtx, activityId: number) {
  const row = await activityRepo.findByIdForUser(ctx.db, ctx.userId, activityId);
  if (!row) throw new AppError(404, `Activity ${activityId} not found for this user.`);
  return row;
}
