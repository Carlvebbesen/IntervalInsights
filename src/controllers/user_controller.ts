import { eq } from "drizzle-orm";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_OF_SERVICE_VERSION,
} from "../consent_versions";
import { toUserDto, type UserDto } from "../dtos/user_dto";
import { AppError } from "../error";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import * as activityRepo from "../repositories/activity_repository";
import * as userRepo from "../repositories/user_repository";
import { events, gears } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export async function getProfile(db: Db, userId: string): Promise<UserDto> {
  const user = await userRepo.findById(db, userId);
  if (!user) throw new AppError(404, "User not found");
  return toUserDto(user);
}

export async function acceptPrivacyPolicy(db: Db, userId: string): Promise<UserDto> {
  const updated = await userRepo.updateById(db, userId, {
    privacyPolicyAcceptedAt: new Date(),
    privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
  });
  if (!updated) throw new AppError(404, "User not found");
  return toUserDto(updated);
}

export async function acceptTermsOfService(db: Db, userId: string): Promise<UserDto> {
  const updated = await userRepo.updateById(db, userId, {
    termsOfServiceAcceptedAt: new Date(),
    termsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
  });
  if (!updated) throw new AppError(404, "User not found");
  return toUserDto(updated);
}

export interface UpdateUserInput {
  maxHeartRate?: number | null;
  processHeartRate?: boolean;
}

export async function updateSettings(
  db: Db,
  userId: string,
  body: UpdateUserInput,
): Promise<UserDto> {
  const updates: UpdateUserInput = {};
  if (body.maxHeartRate !== undefined) updates.maxHeartRate = body.maxHeartRate;
  if (body.processHeartRate !== undefined) updates.processHeartRate = body.processHeartRate;

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "No fields to update");
  }

  const updated = await userRepo.updateById(db, userId, updates);
  if (!updated) throw new AppError(404, "User not found");
  return toUserDto(updated);
}

/**
 * Permanently delete the user. Revoke Strava OAuth FIRST — deleting the user row
 * cascades `oauth_provider_tokens` away, so the token must be read before then.
 * Then the user's activities (interval_segments cascade), events (event_attributes
 * cascade), gears (gear_defaults cascade), and the user row itself (chat
 * conversations/messages + oauth token rows cascade). Events and gears reference
 * users with ON DELETE NO ACTION, so they must be removed explicitly or the user
 * delete fails. External cleanup failures are swallowed so a missing Strava link
 * can't block deletion.
 */
export async function deleteAccount(
  db: Db,
  userId: string,
): Promise<{ success: true; message: string }> {
  try {
    const tokens = await getStravaAccessTokens(userId);
    await fetch("https://www.strava.com/oauth/deauthorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: tokens.access_token }),
    });
  } catch {
    // Strava may not be linked — continue with cleanup
  }

  await activityRepo.deleteAllForUser(db, userId);
  await db.delete(events).where(eq(events.userId, userId));
  await db.delete(gears).where(eq(gears.userId, userId));
  await userRepo.deleteById(db, userId);

  return { success: true, message: "All user data deleted" };
}
