import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import * as gearController from "../controllers/gear_controller";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { gearSurfaceEnum, gearTypeEnum } from "../schema";
import {
  BrandsResponseSchema,
  ClearGearSignatureDefaultResponseSchema,
  CreateGearSchema,
  GearListResponseSchema,
  GearSchema,
  GearSignatureDefaultListResponseSchema,
  GearSignatureDefaultSchema,
  SetGearSignatureDefaultSchema,
  SyncGearResponseSchema,
  UpdateGearSchema,
} from "../schemas/api_schemas";
import { errJson, okJson } from "../schemas/route_helpers";
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

gearRouter.get(
  "/",
  describeRoute({
    description:
      "List the user's gear (shoes). Filter by `surface`, `gearType`, `includeRetired`; sort by `distance` (default), `created`, or `name`.",
    responses: {
      200: okJson(GearListResponseSchema, "Gear list"),
      500: errJson("Internal server error"),
    },
  }),
  validator("query", listQuerySchema),
  async (c) => {
    const result = await gearController.listGears(c.env.db, c.get("userId"), c.req.valid("query"));
    return c.json(result);
  },
);

const brandsQuerySchema = z.object({ gearType: z.enum(gearTypeEnum.enumValues).optional() });

gearRouter.get(
  "/brands",
  describeRoute({
    description:
      "The curated list of brands offered in the create form for a `gearType` (defaults to SHOES).",
    responses: {
      200: okJson(BrandsResponseSchema, "Brand list"),
    },
  }),
  validator("query", brandsQuerySchema),
  async (c) => c.json(gearController.getBrands(c.req.valid("query").gearType)),
);

const structureIdParamSchema = z.object({ structureId: z.coerce.number().int().positive() });

gearRouter.get(
  "/signature-defaults",
  describeRoute({
    description: "The user's per-workout-signature gear defaults.",
    responses: {
      200: okJson(GearSignatureDefaultListResponseSchema, "Signature default list"),
      500: errJson("Internal server error"),
    },
  }),
  async (c) => {
    const result = await gearController.listSignatureDefaults(c.env.db, c.get("userId"));
    return c.json(result);
  },
);

gearRouter.put(
  "/signature-defaults/:structureId",
  describeRoute({
    description:
      "Set a shoe as the default for a workout signature (interval structure). Upserts — replaces any existing default for that signature.",
    responses: {
      200: okJson(GearSignatureDefaultSchema, "The stored signature default"),
      400: errJson("Bad request"),
      404: errJson("Gear or interval structure not found"),
    },
  }),
  validator("param", structureIdParamSchema),
  validator("json", SetGearSignatureDefaultSchema),
  async (c) => {
    const { structureId } = c.req.valid("param");
    const { gearId } = c.req.valid("json");
    const result = await gearController.setSignatureDefault(
      c.env.db,
      c.get("userId"),
      structureId,
      gearId,
    );
    return c.json(result);
  },
);

gearRouter.delete(
  "/signature-defaults/:structureId",
  describeRoute({
    description: "Clear the gear default for a workout signature.",
    responses: {
      200: okJson(ClearGearSignatureDefaultResponseSchema, "Cleared"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", structureIdParamSchema),
  async (c) => {
    const { structureId } = c.req.valid("param");
    const result = await gearController.clearSignatureDefault(
      c.env.db,
      c.get("userId"),
      structureId,
    );
    return c.json(result);
  },
);

gearRouter.post(
  "/",
  describeRoute({
    description:
      "Create a shoe. Optional `defaultEasy/Long/Intervals/Race` set it as the default for those buckets on its surface.",
    responses: {
      201: okJson(GearSchema, "Created gear"),
      400: errJson("Bad request"),
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
      200: okJson(GearSchema, "Updated gear"),
      400: errJson("Bad request"),
      404: errJson("Gear not found"),
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

const gearStravaRouter = new Hono<TStravaEnv>();
gearStravaRouter.use("*", stravaMiddleware);

gearStravaRouter.post(
  "/sync",
  describeRoute({
    description:
      "Sync shoes from Strava: import any missing shoes and refresh every shoe's distance/baseline. Requires a linked Strava account.",
    responses: {
      200: okJson(SyncGearResponseSchema, "Sync summary"),
      403: errJson("Strava account not linked"),
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
