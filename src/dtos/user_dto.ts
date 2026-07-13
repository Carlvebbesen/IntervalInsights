import type { z } from "zod";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_OF_SERVICE_VERSION,
} from "../consent_versions";
import type { UserDao } from "../repositories/user_repository";
import type { UserSettingsDao } from "../repositories/user_settings_repository";
import type { UserSchema, UserSettingsSchema } from "../schemas/api_schemas";

export type UserDto = z.infer<typeof UserSchema>;
export type UserSettingsDto = z.infer<typeof UserSettingsSchema>;

export function toUserSettingsDto(settings: UserSettingsDao): UserSettingsDto {
  return {
    waitForStravaUpdate: settings.waitForStravaUpdate,
    analysisReviewMode: settings.analysisReviewMode,
    maxHeartRate: settings.maxHeartRate,
    processHeartRate: settings.processHeartRate,
  };
}

/**
 * `maxHeartRate`/`processHeartRate` are read FROM `settings` (not the `users`
 * row) — old Shorebird clients still read these top-level fields, but
 * `settings` is now the source of truth (see analysis-settings migration).
 */
export function toUserDto(dao: UserDao, settings: UserSettingsDao): UserDto {
  return {
    id: dao.id,
    clerkId: dao.clerkId,
    email: dao.email,
    name: dao.name,
    image: dao.image,
    stravaId: dao.stravaId,
    role: dao.role,
    maxHeartRate: settings.maxHeartRate,
    processHeartRate: settings.processHeartRate,
    privacyPolicyAcceptedAt: dao.privacyPolicyAcceptedAt?.toISOString() ?? null,
    privacyPolicyVersion: dao.privacyPolicyVersion,
    currentPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    termsOfServiceAcceptedAt: dao.termsOfServiceAcceptedAt?.toISOString() ?? null,
    termsOfServiceVersion: dao.termsOfServiceVersion,
    currentTermsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
    settings: toUserSettingsDto(settings),
  };
}
