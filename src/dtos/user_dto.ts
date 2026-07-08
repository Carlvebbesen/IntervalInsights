import type { z } from "zod";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_OF_SERVICE_VERSION,
} from "../consent_versions";
import type { UserDao } from "../repositories/user_repository";
import type { UserSchema } from "../schemas/api_schemas";

export type UserDto = z.infer<typeof UserSchema>;

export function toUserDto(dao: UserDao): UserDto {
  return {
    id: dao.id,
    clerkId: dao.clerkId,
    email: dao.email,
    name: dao.name,
    image: dao.image,
    stravaId: dao.stravaId,
    role: dao.role,
    maxHeartRate: dao.maxHeartRate,
    processHeartRate: dao.processHeartRate,
    privacyPolicyAcceptedAt: dao.privacyPolicyAcceptedAt?.toISOString() ?? null,
    privacyPolicyVersion: dao.privacyPolicyVersion,
    currentPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    termsOfServiceAcceptedAt: dao.termsOfServiceAcceptedAt?.toISOString() ?? null,
    termsOfServiceVersion: dao.termsOfServiceVersion,
    currentTermsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
  };
}
