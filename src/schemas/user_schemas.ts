import "zod-openapi/extend";
import { z } from "zod";
import { analysisReviewModeEnum, paceProgressionEnum, sexEnum, userRoleEnum } from "../schema/enums";

export const UserSettingsSchema = z
  .object({
    waitForStravaUpdate: z.boolean(),
    analysisReviewMode: z.enum(analysisReviewModeEnum.enumValues),
    maxHeartRate: z.number().nullable(),
    processHeartRate: z.boolean(),
    paceProgression: z.enum(paceProgressionEnum.enumValues),
    thresholdPaceMps: z.number().nullable(),
    lthr: z.number().nullable(),
    restingHr: z.number().nullable(),
    ftp: z.number().nullable(),
    sex: z.enum(sexEnum.enumValues).nullable(),
  })
  .openapi({ ref: "UserSettings" });

export const UpdateUserSettingsSchema = z
  .object({
    waitForStravaUpdate: z.boolean().optional(),
    analysisReviewMode: z.enum(analysisReviewModeEnum.enumValues).optional(),
    maxHeartRate: z.number().int().positive().max(250).nullable().optional(),
    processHeartRate: z.boolean().optional(),
    paceProgression: z.enum(paceProgressionEnum.enumValues).optional(),
    thresholdPaceMps: z.number().positive().max(12).nullable().optional(),
    lthr: z.number().int().min(80).max(220).nullable().optional(),
    restingHr: z.number().int().min(20).max(120).nullable().optional(),
    ftp: z.number().int().min(50).max(600).nullable().optional(),
    sex: z.enum(sexEnum.enumValues).nullable().optional(),
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
