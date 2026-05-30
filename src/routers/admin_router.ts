import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as adminController from "../controllers/admin_controller";
import { requireRole } from "../middlewares/role_middleware";
import { ErrorSchema } from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const adminRouter = new Hono<TGlobalEnv>();

adminRouter.use("*", requireRole("admin"));

const roleParamSchema = z.object({
  id: z.string().min(1),
});

const roleSchema = z.object({
  role: z.enum(["guest", "premium", "admin"]),
});

const roleResponseSchema = z.object({
  id: z.string(),
  role: z.enum(["guest", "premium", "admin"]),
});

adminRouter.patch(
  "/users/:id/role",
  describeRoute({
    description:
      "Set a user's role (admin only). Invalidates the user's Clerk public-metadata cache.",
    responses: {
      200: {
        description: "Updated user role",
        content: { "application/json": { schema: resolver(roleResponseSchema) } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", roleParamSchema),
  validator("json", roleSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const result = await adminController.setUserRole(c.env.db, id, role);
    return c.json(result);
  },
);

export default adminRouter;
