import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  getConversation,
  listConversations,
  streamCoachChat,
} from "../controllers/training_controller";
import { requireRole } from "../middlewares/role_middleware";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import {
  ChatConversationDetailSchema,
  ChatConversationListSchema,
  CoachChatRequestSchema,
  ErrorSchema,
} from "../schemas/api_schemas";
import type { TStravaEnv } from "../types/IRouters";

const trainingRouter = new Hono<TStravaEnv>();

trainingRouter.use("*", requireRole("premium", "admin"));

trainingRouter.post(
  "/",
  describeRoute({
    description:
      "Streaming training-coach chat (Server-Sent Events). Answers questions about the athlete's own training data, analyses it, and suggests workouts (read-only). Emits `status`, `token`, `artifact` (rendered cards: workout/chart/table/stat cards/weekly plan), `done` and `error` events.",
    responses: {
      200: {
        description: "SSE stream of status/token/done events.",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      403: {
        description: "Forbidden (not a premium user / Strava not linked)",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  stravaMiddleware,
  validator("json", CoachChatRequestSchema),
  (c) => streamCoachChat(c, c.req.valid("json")),
);

trainingRouter.get(
  "/conversations",
  describeRoute({
    description: "List the current user's past chat conversations, most recent first (paginated).",
    responses: {
      200: {
        description: "Conversations page",
        content: { "application/json": { schema: resolver(ChatConversationListSchema) } },
      },
    },
  }),
  validator("query", z.object({ page: z.coerce.number().int().min(1).default(1) })),
  async (c) => {
    const { page } = c.req.valid("query");
    const result = await listConversations(c.env.db, c.get("userId"), page);
    return c.json(result, 200);
  },
);

trainingRouter.get(
  "/conversations/:id",
  describeRoute({
    description: "Fetch one conversation's full transcript (ownership-checked).",
    responses: {
      200: {
        description: "Conversation transcript",
        content: { "application/json": { schema: resolver(ChatConversationDetailSchema) } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", z.object({ id: z.string().uuid() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await getConversation(c.env.db, c.get("userId"), id);
    return c.json(result, 200);
  },
);

export default trainingRouter;
