import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as gearController from "../controllers/gear_controller";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { gearSurfaceEnum, gearTypeEnum } from "../schema";
import {
  BrandsResponseSchema,
  CreateGearSchema,
  ErrorSchema,
  GearDefaultsResponseSchema,
  GearListResponseSchema,
  GearSchema,
  SetGearDefaultSchema,
  SyncGearResponseSchema,
  UpdateGearSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv, TStravaEnv } from "../types/IRouters";

const gearRouter = new Hono<TGlobalEnv>();

const listQuerySchema = z.object({
  surface: z.enum(gearSurfaceEnum.enumValues).optional(),
  gearType: z.enum(gearTypeEnum.enumValues).optional(),
  includeRetired: z.coerce.boolean().optional(),
  sortBy: z.enum(["distance", "created", "name"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const gearIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const jsonError = (description: string) => ({
  description,
  content: { "application/json": { schema: resolver(ErrorSchema) } },
});

gearRouter.get(
  "/",
  describeRoute({
    description:
      "List the user's gear (shoes). Filter by `surface`, `gearType`, `includeRetired`; sort by `distance` (default), `created`, or `name`.",
    responses: {
      200: {
        description: "Gear list",
        content: { "application/json": { schema: resolver(GearListResponseSchema) } },
      },
      500: jsonError("Internal server error"),
    },
  }),
  validator("query", listQuerySchema),
  async (c) => {
    const result = await gearController.listGears(c.env.db, c.get("userId"), c.req.valid("query"));
    return c.json(result);
  },
);

gearRouter.get(
  "/brands",
  describeRoute({
    description: "The curated list of shoe brands offered in the create form.",
    responses: {
      200: {
        description: "Brand list",
        content: { "application/json": { schema: resolver(BrandsResponseSchema) } },
      },
    },
  }),
  async (c) => c.json(gearController.getBrands()),
);

gearRouter.get(
  "/defaults",
  describeRoute({
    description: "The user's default gear per (training bucket, surface).",
    responses: {
      200: {
        description: "Gear defaults",
        content: { "application/json": { schema: resolver(GearDefaultsResponseSchema) } },
      },
    },
  }),
  async (c) => c.json(await gearController.getGearDefaults(c.env.db, c.get("userId"))),
);

gearRouter.put(
  "/defaults",
  describeRoute({
    description:
      "Set or clear (gearId=null) the default gear for one (bucket, surface). Replaces any existing default for that slot.",
    responses: {
      200: {
        description: "Updated gear defaults",
        content: { "application/json": { schema: resolver(GearDefaultsResponseSchema) } },
      },
      404: jsonError("Gear not found"),
    },
  }),
  validator("json", SetGearDefaultSchema),
  async (c) => {
    const result = await gearController.setGearDefault(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json(result);
  },
);

gearRouter.post(
  "/",
  describeRoute({
    description:
      "Create a shoe. Optional `defaultEasy/Long/Intervals` set it as the default for those buckets on its surface.",
    responses: {
      201: {
        description: "Created gear",
        content: { "application/json": { schema: resolver(GearSchema) } },
      },
      400: jsonError("Bad request"),
    },
  }),
  validator("json", CreateGearSchema),
  async (c) => {
    const created = await gearController.createGear(c.env.db, c.get("userId"), c.req.valid("json"));
    return c.json(created, 201);
  },
);

gearRouter.patch(
  "/:id",
  describeRoute({
    description:
      "Edit a shoe (brand/model/nickname/surface), retire/unretire (`isActive`), or set its default buckets. Retiring clears its defaults.",
    responses: {
      200: {
        description: "Updated gear",
        content: { "application/json": { schema: resolver(GearSchema) } },
      },
      400: jsonError("Bad request"),
      404: jsonError("Gear not found"),
    },
  }),
  validator("param", gearIdParamSchema),
  validator("json", UpdateGearSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const updated = await gearController.updateGear(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(updated);
  },
);

// Needs a Strava token → separate sub-router with stravaMiddleware.
const gearStravaRouter = new Hono<TStravaEnv>();
gearStravaRouter.use("*", stravaMiddleware);

gearStravaRouter.post(
  "/sync",
  describeRoute({
    description:
      "Sync shoes from Strava: import any missing shoes and refresh every shoe's distance/baseline. Requires a linked Strava account.",
    responses: {
      200: {
        description: "Sync summary",
        content: { "application/json": { schema: resolver(SyncGearResponseSchema) } },
      },
      403: jsonError("Strava account not linked"),
    },
  }),
  async (c) => {
    const result = await gearController.syncFromStrava(
      c.env.db,
      c.get("userId"),
      c.get("stravaAccessToken"),
    );
    return c.json(result);
  },
);

export { gearStravaRouter };
export default gearRouter;
