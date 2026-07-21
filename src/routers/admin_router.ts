import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as adminController from "../controllers/admin_controller";
import { requireRole } from "../middlewares/role_middleware";
import {
  AdminSetBannedResponseSchema,
  AdminSetBannedSchema,
  AdminSetRoleResponseSchema,
  AdminSetRoleSchema,
  AdminStatsSchema,
  AdminUserListQuerySchema,
  AdminUserListResponseSchema,
} from "../schemas/admin_schemas";
import { ErrorSchema } from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const adminRouter = new Hono<TGlobalEnv>();

adminRouter.use("*", requireRole("admin"));

const userIdParamSchema = z.object({
  id: z.string().min(1),
});

adminRouter.get(
  "/stats",
  describeRoute({
    description: "User-base statistics for the admin console (counts, activity, role breakdown).",
    responses: {
      200: {
        description: "Aggregate user statistics",
        content: { "application/json": { schema: resolver(AdminStatsSchema) } },
      },
    },
  }),
  async (c) => {
    const stats = await adminController.getStats(c.env.db);
    return c.json(stats);
  },
);

adminRouter.get(
  "/users",
  describeRoute({
    description:
      "List users (admin only), newest first. Optional filters: `q` (email/name search), " +
      "`role`, `banned`. Paginated via `page`/`pageSize`.",
    responses: {
      200: {
        description: "Paginated users",
        content: { "application/json": { schema: resolver(AdminUserListResponseSchema) } },
      },
    },
  }),
  validator("query", AdminUserListQuerySchema),
  async (c) => {
    const result = await adminController.listUsers(c.env.db, c.req.valid("query"));
    return c.json(result);
  },
);

adminRouter.patch(
  "/users/:id/role",
  describeRoute({
    description:
      "Set a user's role (admin only). Role is stored in the DB users table (source of truth). " +
      "The admin role is out of reach: it cannot be granted here, and users who already hold it " +
      "cannot be modified — both require a direct database update.",
    responses: {
      200: {
        description: "Updated user role",
        content: { "application/json": { schema: resolver(AdminSetRoleResponseSchema) } },
      },
      403: {
        description: "Attempted to grant admin or to modify an existing admin",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", userIdParamSchema),
  validator("json", AdminSetRoleSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const result = await adminController.setUserRole(c.env.db, id, role);
    return c.json(result);
  },
);

adminRouter.patch(
  "/users/:id/ban",
  describeRoute({
    description:
      "Block or unblock a user (admin only). Blocking revokes the user's sessions via Better Auth " +
      "so every subsequent request is rejected. Bans are permanent. An admin cannot ban themselves " +
      "or another admin.",
    responses: {
      200: {
        description: "Updated ban status",
        content: { "application/json": { schema: resolver(AdminSetBannedResponseSchema) } },
      },
      403: {
        description: "Attempted to ban self or another admin",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", userIdParamSchema),
  validator("json", AdminSetBannedSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { banned, reason } = c.req.valid("json");
    const result = await adminController.setBanned(
      c.env.db,
      c.req.raw.headers,
      c.get("userId"),
      id,
      banned,
      reason,
    );
    return c.json(result);
  },
);

export default adminRouter;
