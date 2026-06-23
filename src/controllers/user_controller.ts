import { createClerkClient } from "@clerk/backend";
import { config } from "../config";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_OF_SERVICE_VERSION,
} from "../consent_versions";
import { toUserDto, type UserDto } from "../dtos/user_dto";
import { AppError } from "../error";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import * as activityRepo from "../repositories/activity_repository";
import * as userRepo from "../repositories/user_repository";
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
 * Permanently delete the user: their activities (interval_segments cascade), the
 * user row, then revoke Strava OAuth and clear Clerk metadata. External cleanup
 * failures are swallowed so a missing Strava link can't block account deletion.
 */
export async function deleteAccount(
  db: Db,
  userId: string,
  clerkUserId: string,
): Promise<{ success: true; message: string }> {
  await activityRepo.deleteAllForUser(db, userId);
  await userRepo.deleteById(db, userId);

  const clerkClient = createClerkClient({ secretKey: config.CLERK_SECRET_KEY });
  try {
    const tokens = await getStravaAccessTokens(clerkUserId);
    await fetch("https://www.strava.com/oauth/deauthorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: tokens.access_token }),
    });
  } catch {
    // Strava may not be linked — continue with cleanup
  }

  await clerkClient.users.updateUserMetadata(clerkUserId, {
    privateMetadata: { strava: null, intervals: null },
  });

  return { success: true, message: "All user data deleted" };
}
