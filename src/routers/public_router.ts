import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import * as webhookController from "../controllers/webhook_controller";
import { ErrorSchema } from "../schemas/api_schemas";
import type { TPublicEnv } from "../types/IRouters";
import type { IIntervalsWebhookPayload } from "../types/intervals/IIntervalsWebhookEvent";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";

const publicRouter = new Hono<TPublicEnv>();

const StravaHandshakeQuerySchema = z.object({
  "hub.mode": z.string().optional(),
  "hub.verify_token": z.string().optional(),
  "hub.challenge": z.string().optional(),
});

const StravaHandshakeResponseSchema = z.object({
  "hub.challenge": z.string().optional(),
});

const StravaWebhookEventSchema = z.object({
  object_type: z.enum(["activity", "athlete"]),
  object_id: z.number(),
  aspect_type: z.enum(["create", "update", "delete"]),
  updates: z.record(z.string(), z.unknown()).optional(),
  owner_id: z.number(),
  subscription_id: z.number(),
  event_time: z.number(),
});

const StravaWebhookAckSchema = z.object({
  status: z.enum(["ok", "unauthorized"]),
});

publicRouter.get(
  "/strava/event",
  describeRoute({
    description:
      "Strava webhook subscription handshake. Strava calls this with hub.mode/hub.verify_token/hub.challenge query params; we echo the challenge if the verify token matches.",
    security: [],
    responses: {
      200: {
        description: "Handshake accepted; echoes hub.challenge",
        content: {
          "application/json": { schema: resolver(StravaHandshakeResponseSchema) },
        },
      },
      403: {
        description: "Verification failed (token mismatch or invalid mode)",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", StravaHandshakeQuerySchema),
  (c) => {
    const challenge = webhookController.verifyStravaHandshake(
      c.req.query("hub.mode"),
      c.req.query("hub.verify_token"),
      c.req.query("hub.challenge"),
      c.var.logger,
    );
    if (challenge === null) {
      return c.json({ error: "Verification failed" }, 403);
    }
    return c.json({ "hub.challenge": challenge }, 200);
  },
);

publicRouter.get(
  "/health",
  describeRoute({
    description: "Liveness probe",
    security: [],
    responses: {
      200: {
        description: "Service is alive",
        content: { "application/json": { schema: resolver(z.string()) } },
      },
    },
  }),
  (c) => {
    c.var.logger.debug("Health triggered");
    return c.json("i'm alive :D ", 200);
  },
);

publicRouter.get(
  "/privacy-policy",
  describeRoute({
    description: "Public privacy policy as Markdown.",
    security: [],
    responses: {
      200: {
        description: "Privacy policy markdown source",
        content: {
          "text/markdown": { schema: resolver(z.string()) },
        },
      },
    },
  }),
  async (_c) => {
    const markdown = await Bun.file(
      new URL("../privacy_policy.md", import.meta.url).pathname,
    ).text();
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
);

publicRouter.get(
  "/terms-of-service",
  describeRoute({
    description: "Public terms of service as Markdown.",
    security: [],
    responses: {
      200: {
        description: "Terms of service markdown source",
        content: {
          "text/markdown": { schema: resolver(z.string()) },
        },
      },
    },
  }),
  async (_c) => {
    const markdown = await Bun.file(
      new URL("../terms_of_service.md", import.meta.url).pathname,
    ).text();
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
);

publicRouter.post(
  "/strava/event",
  describeRoute({
    description:
      "Strava webhook delivery. Authenticated by matching subscription_id against STRAVA_SUBSCRIPTION_ID; processing is fire-and-forget.",
    security: [],
    responses: {
      200: {
        description: "Event accepted for background processing",
        content: { "application/json": { schema: resolver(StravaWebhookAckSchema) } },
      },
      401: {
        description: "subscription_id did not match",
        content: { "application/json": { schema: resolver(StravaWebhookAckSchema) } },
      },
    },
  }),
  validator("json", StravaWebhookEventSchema),
  async (c) => {
    const body = (await c.req.json()) as IStravaWebhookEvent;
    const ok = webhookController.handleStravaWebhook(body, c.env, c.var.logger);
    return ok ? c.json({ status: "ok" }, 200) : c.json({ status: "unauthorized" }, 401);
  },
);

const IntervalsActivityEventSchema = z.object({
  type: z.enum(["ACTIVITY_UPLOADED", "ACTIVITY_UPDATED", "ACTIVITY_ANALYZED", "ACTIVITY_DELETED"]),
  athlete_id: z.string(),
  timestamp: z.string().optional(),
  activity: z
    .object({ id: z.union([z.string(), z.number()]) })
    .passthrough()
    .optional(),
});

const IntervalsScopeChangeEventSchema = z.object({
  type: z.literal("APP_SCOPE_CHANGED"),
  athlete_id: z.string(),
  timestamp: z.string().optional(),
});

const IntervalsTestEventSchema = z.object({
  type: z.literal("TEST"),
  athlete_id: z.string(),
  timestamp: z.string().optional(),
});

const IntervalsUnknownEventSchema = z
  .object({
    type: z.string(),
    athlete_id: z.string(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const IntervalsWebhookEventSchema = z.union([
  IntervalsActivityEventSchema,
  IntervalsScopeChangeEventSchema,
  IntervalsTestEventSchema,
  IntervalsUnknownEventSchema,
]);

const IntervalsWebhookPayloadSchema = z.object({
  secret: z.string(),
  events: z.array(IntervalsWebhookEventSchema),
});

const IntervalsWebhookAckSchema = z.object({
  status: z.enum(["ok", "unauthorized"]),
});

publicRouter.post(
  "/intervals/event",
  async (c, next) => {
    const raw = await c.req.raw.clone().text();
    c.var.logger.info({ raw }, "intervals.icu raw inbound body");
    return next();
  },
  describeRoute({
    description:
      "Intervals.icu webhook delivery. Authenticated by matching the shared secret against INTERVALS_WEBHOOK_SECRET; processing is fire-and-forget.",
    security: [],
    responses: {
      200: {
        description: "Event accepted for background processing",
        content: { "application/json": { schema: resolver(IntervalsWebhookAckSchema) } },
      },
      401: {
        description: "Shared secret did not match",
        content: { "application/json": { schema: resolver(IntervalsWebhookAckSchema) } },
      },
    },
  }),
  validator("json", IntervalsWebhookPayloadSchema),
  async (c) => {
    const body: IIntervalsWebhookPayload = c.req.valid("json");
    const ok = webhookController.handleIntervalsWebhook(body, c.env, c.var.logger);
    return ok ? c.json({ status: "ok" }, 200) : c.json({ status: "unauthorized" }, 401);
  },
);

publicRouter.route("/", publicRouter);

export default publicRouter;
