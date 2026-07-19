import "zod-openapi/extend";
import { z } from "zod";
import { userRoleEnum } from "../schema/enums";

export const AdminStatsSchema = z
  .object({
    totalUsers: z.number(),
    activeToday: z.number(),
    activeThisWeek: z.number(),
    activeThisMonth: z.number(),
    newToday: z.number(),
    newThisWeek: z.number(),
    bannedCount: z.number(),
    roleBreakdown: z.object({
      guest: z.number(),
      premium: z.number(),
      admin: z.number(),
    }),
  })
  .openapi({ ref: "AdminStats" });

export const AdminUserSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    role: z.enum(userRoleEnum.enumValues),
    banned: z.boolean(),
    banReason: z.string().nullable(),
    createdAt: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
  })
  .openapi({ ref: "AdminUser" });

export const AdminUserListResponseSchema = z
  .object({
    data: z.array(AdminUserSchema),
    meta: z.object({
      page: z.number(),
      pageSize: z.number(),
      total: z.number(),
    }),
  })
  .openapi({ ref: "AdminUserListResponse" });

export const AdminUserListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  role: z.enum(userRoleEnum.enumValues).optional(),
  banned: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const AdminSetRoleSchema = z.object({
  role: z.enum(["guest", "premium"]),
});

export const AdminSetRoleResponseSchema = z
  .object({
    id: z.string(),
    role: z.enum(["guest", "premium"]),
  })
  .openapi({ ref: "AdminSetRoleResponse" });

export const AdminSetBannedSchema = z.object({
  banned: z.boolean(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const AdminSetBannedResponseSchema = z
  .object({
    id: z.string(),
    banned: z.boolean(),
    banReason: z.string().nullable(),
  })
  .openapi({ ref: "AdminSetBannedResponse" });

export type AdminUserRow = z.infer<typeof AdminUserSchema>;
