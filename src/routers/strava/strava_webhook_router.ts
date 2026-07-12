import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { requireRole } from "../../middlewares/role_middleware";
import {
  createPushSubscription,
  deletePushSubscription,
  listPushSubscriptions,
} from "../../services/strava_webhook_service";
import type { TStravaEnv } from "../../types/IRouters";

const stravaWebhookRouter = new Hono<TStravaEnv>();

stravaWebhookRouter.use("*", requireRole("admin"));

const StravaWebhookCreateSubscriptionResponseSchema = z
  .object({
    id: z.number().optional(),
    application_id: z.number().optional(),
    callback_url: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const StravaWebhookSubscriptionItemSchema = z
  .object({
    id: z.number(),
    application_id: z.number().optional(),
    callback_url: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const SubscriptionListResponseSchema = z.array(StravaWebhookSubscriptionItemSchema);

const SubscriptionDeleteSuccessSchema = z.object({ message: z.string() });
const SubscriptionDeleteParamSchema = z.object({ id: z.string() });

stravaWebhookRouter.get(
  "/subscribe",
  describeRoute({
    description:
      "Create the Strava push subscription pointing back to /api/strava/event. Idempotent — Strava rejects duplicates with 400.",
    responses: {
      200: {
        description: "Subscription created",
        content: {
          "application/json": {
            schema: resolver(StravaWebhookCreateSubscriptionResponseSchema),
          },
        },
      },
      400: {
        description: "Strava rejected the subscription request (e.g. duplicate)",
        content: {
          "application/json": {
            schema: resolver(StravaWebhookCreateSubscriptionResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    const { status, body } = await createPushSubscription(c.var.logger);
    return c.json(body, status as ContentfulStatusCode);
  },
);

stravaWebhookRouter.get(
  "/subscription",
  describeRoute({
    description:
      "List existing Strava push subscriptions for our application client. Useful for verifying the current subscription ID before deleting/recreating.",
    responses: {
      200: {
        description: "Subscription list",
        content: {
          "application/json": { schema: resolver(SubscriptionListResponseSchema) },
        },
      },
    },
  }),
  async (c) => {
    const { status, body } = await listPushSubscriptions();
    return c.json(body, status as ContentfulStatusCode);
  },
);

stravaWebhookRouter.delete(
  "/subscription/:id",
  describeRoute({
    description: "Delete a Strava push subscription by ID.",
    responses: {
      200: {
        description: "Subscription deleted",
        content: {
          "application/json": { schema: resolver(SubscriptionDeleteSuccessSchema) },
        },
      },
      404: {
        description: "Strava reports the subscription does not exist",
        content: { "application/json": { schema: resolver(z.unknown()) } },
      },
    },
  }),
  validator("param", SubscriptionDeleteParamSchema),
  async (c) => {
    const { status, body } = await deletePushSubscription(c.req.param("id"));
    if (status === 204) {
      return c.json({ message: "Subscription deleted successfully" }, 200);
    }
    return c.json(body, status as ContentfulStatusCode);
  },
);

export default stravaWebhookRouter;
