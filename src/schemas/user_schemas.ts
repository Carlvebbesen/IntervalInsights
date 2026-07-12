import "zod-openapi/extend";
import { z } from "zod";
import { analysisReviewModeEnum, userRoleEnum } from "../schema/enums";

export const UserSettingsSchema = z
  .object({
    waitForStravaUpdate: z.boolean(),
    analysisReviewMode: z.enum(analysisReviewModeEnum.enumValues),
    maxHeartRate: z.number().nullable(),
    processHeartRate: z.boolean(),
  })
  .openapi({ ref: "UserSettings" });

export const UpdateUserSettingsSchema = z
  .object({
    waitForStravaUpdate: z.boolean().optional(),
    analysisReviewMode: z.enum(analysisReviewModeEnum.enumValues).optional(),
    maxHeartRate: z.number().int().positive().max(250).nullable().optional(),
    processHeartRate: z.boolean().optional(),
  })
  .openapi({ ref: "UpdateUserSettings" });

export const UserSchema = z
  .object({
    id: z.string(),
    clerkId: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    image: z.string().nullable(),
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
    settings: UserSettingsSchema,
  })
  .openapi({ ref: "User" });

export const DeleteAccountResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
  })
  .openapi({ ref: "DeleteAccountResponse" });
