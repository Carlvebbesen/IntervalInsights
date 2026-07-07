import "zod-openapi/extend";
import { z } from "zod";
import { gearSurfaceEnum, gearTypeEnum, trainingTypeEnum } from "../schema/enums";

export const GearSummarySchema = z
  .object({
    id: z.number(),
    brand: z.string().nullable(),
    model: z.string(),
    nickname: z.string().nullable(),
    displayName: z.string(),
    surface: z.enum(gearSurfaceEnum.enumValues),
    isActive: z.boolean(),
  })
  .openapi({ ref: "GearSummary" });

export const GearSchema = z
  .object({
    id: z.number(),
    gearType: z.enum(gearTypeEnum.enumValues),
    brand: z.string().nullable(),
    model: z.string(),
    nickname: z.string().nullable(),
    displayName: z.string(),
    surface: z.enum(gearSurfaceEnum.enumValues),
    useTypes: z.array(z.enum(trainingTypeEnum.enumValues)),
    isActive: z.boolean(),
    retiredAt: z.string().nullable(),
    stravaGearId: z.string().nullable(),
    baselineDistanceMeters: z.number(),
    baselineDate: z.string().nullable(),
    maintainedDistanceMeters: z.number(),
    distanceMeters: z.number(),
    distanceKm: z.number(),
    activityCount: z.number(),
    isDefaultEasy: z.boolean(),
    isDefaultLong: z.boolean(),
    isDefaultIntervals: z.boolean(),
    isDefaultRace: z.boolean(),
    trainingTypeCounts: z.record(z.string(), z.number()),
    createdAt: z.string().nullable(),
  })
  .openapi({ ref: "Gear" });

export const GearListResponseSchema = z
  .object({ data: z.array(GearSchema) })
  .openapi({ ref: "GearListResponse" });

export const CreateGearSchema = z
  .object({
    brand: z.string().nullable().optional(),
    model: z.string().min(1),
    nickname: z.string().nullable().optional(),
    surface: z.enum(gearSurfaceEnum.enumValues),
    gearType: z.enum(gearTypeEnum.enumValues).optional(),
    useTypes: z.array(z.enum(trainingTypeEnum.enumValues)).optional(),
    defaultEasy: z.boolean().optional(),
    defaultLong: z.boolean().optional(),
    defaultIntervals: z.boolean().optional(),
    defaultRace: z.boolean().optional(),
  })
  .openapi({ ref: "CreateGear" });

export const UpdateGearSchema = z
  .object({
    brand: z.string().nullable().optional(),
    model: z.string().min(1).optional(),
    nickname: z.string().nullable().optional(),
    surface: z.enum(gearSurfaceEnum.enumValues).optional(),
    useTypes: z.array(z.enum(trainingTypeEnum.enumValues)).optional(),
    isActive: z.boolean().optional(),
    defaultEasy: z.boolean().optional(),
    defaultLong: z.boolean().optional(),
    defaultIntervals: z.boolean().optional(),
    defaultRace: z.boolean().optional(),
  })
  .openapi({ ref: "UpdateGear" });

export const BrandsResponseSchema = z
  .object({ brands: z.array(z.string()) })
  .openapi({ ref: "BrandsResponse" });

export const GearSignatureDefaultSchema = z
  .object({
    intervalStructureId: z.number(),
    gearId: z.number(),
  })
  .openapi({ ref: "GearSignatureDefault" });

export const GearSignatureDefaultListResponseSchema = z
  .object({ data: z.array(GearSignatureDefaultSchema) })
  .openapi({ ref: "GearSignatureDefaultListResponse" });

export const SetGearSignatureDefaultSchema = z
  .object({ gearId: z.number().int().positive() })
  .openapi({ ref: "SetGearSignatureDefault" });

export const ClearGearSignatureDefaultResponseSchema = z
  .object({ success: z.boolean() })
  .openapi({ ref: "ClearGearSignatureDefaultResponse" });

export const AssignGearSchema = z
  .object({ gearId: z.number().nullable() })
  .openapi({ ref: "AssignGear" });

export const SyncGearResponseSchema = z
  .object({
    created: z.number(),
    updated: z.number(),
    linked: z.number(),
  })
  .openapi({ ref: "SyncGearResponse" });
