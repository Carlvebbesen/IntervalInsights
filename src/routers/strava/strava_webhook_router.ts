import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { config } from "../../config";
import type { TStravaEnv } from "../../types/IRouters";

const STRAVA_CLIENT_ID = config.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = config.STRAVA_CLIENT_SECRET;
const STRAVA_WEBHOOK_VERIFY_TOKEN = config.STRAVA_WEBHOOK_VERIFY_TOKEN;

const stravaWebhookRouter = new Hono<TStravaEnv>();

// Strava returns various error/success shapes; document what we surface.
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
    const CALLBACK_URL = `${config.APP_BASE_URL}api/strava/event`;
    c.var.logger.info({ callbackUrl: CALLBACK_URL }, "Setting up Strava subscription");
    const formData = new FormData();
    formData.append("client_id", STRAVA_CLIENT_ID);
    formData.append("client_secret", STRAVA_CLIENT_SECRET);
    formData.append("callback_url", CALLBACK_URL);
    formData.append("verify_token", STRAVA_WEBHOOK_VERIFY_TOKEN);

    const response = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (response.ok) {
      c.var.logger.info({ data }, "Subscription request sent successfully");
    } else {
      c.var.logger.error({ data }, "Subscription request failed");
    }
    return c.json(data, response.status as ContentfulStatusCode);
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
    const url = new URL("https://www.strava.com/api/v3/push_subscriptions");
    url.searchParams.append("client_id", STRAVA_CLIENT_ID);
    url.searchParams.append("client_secret", STRAVA_CLIENT_SECRET);

    const response = await fetch(url.toString(), {
      method: "GET",
    });

    const data = await response.json();
    return c.json(data, response.status as ContentfulStatusCode);
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
    const id = c.req.param("id");
    const url = new URL(`https://www.strava.com/api/v3/push_subscriptions/${id}`);
    url.searchParams.append("client_id", STRAVA_CLIENT_ID);
    url.searchParams.append("client_secret", STRAVA_CLIENT_SECRET);

    const response = await fetch(url.toString(), {
      method: "DELETE",
    });

    if (response.status === 204) {
      return c.json({ message: "Subscription deleted successfully" }, 200);
    }

    const errorData = await response.json();
    return c.json(errorData, response.status as ContentfulStatusCode);
  },
);

export default stravaWebhookRouter;
