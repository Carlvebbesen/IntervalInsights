import "zod-openapi/extend";
import { z } from "zod";
import { userRoleEnum } from "../schema/enums";

export const UserSchema = z
  .object({
    id: z.string(),
    clerkId: z.string(),
    stravaId: z.string().nullable(),
    role: z.enum(userRoleEnum.enumValues).nullable(),
    maxHeartRate: z.number().nullable(),
    processHeartRate: z.boolean(),
    privacyPolicyAcceptedAt: z.string().nullable(),
    privacyPolicyVersion: z.string().nullable(),
    currentPrivacyPolicyVersion: z.string(),
    termsOfServiceAcceptedAt: z.string().nullable(),
    termsOfServiceVersion: z.string().nullable(),
    currentTermsOfServiceVersion: z.string(),
  })
  .openapi({ ref: "User" });

export const DeleteAccountResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
  })
  .openapi({ ref: "DeleteAccountResponse" });
