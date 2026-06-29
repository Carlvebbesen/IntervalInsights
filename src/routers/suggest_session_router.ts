import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as suggestSessionController from "../controllers/suggest_session_controller";
import {
  ErrorSchema,
  SuggestSessionRequestSchema,
  SuggestSessionResponseSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const suggestSessionRouter = new Hono<TGlobalEnv>();

suggestSessionRouter.post(
  "/suggest-session",
  describeRoute({
    description:
      "Suggest a structured interval session for a day, with readiness-adjusted target paces (from the athlete's own history) and a human-readable readiness advisory. Non-streaming, free for all users. Cached briefly per (user, structure, day).",
    responses: {
      200: {
        description: "Suggested session with readiness-adjusted paces and advisory.",
        content: { "application/json": { schema: resolver(SuggestSessionResponseSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Structure not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      422: {
        description: "Saved structure has no stored workout shape",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", SuggestSessionRequestSchema),
  async (c) => {
    const { structureId, structure, date, weather, mode } = c.req.valid("json");
    const result = await suggestSessionController.suggestSession(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      { structureId, structure, date, weather, mode },
      c.var.logger,
    );
    return c.json(result);
  },
);

export default suggestSessionRouter;
