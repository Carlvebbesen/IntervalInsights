import { env } from "bun";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { ErrorSchema } from "../schemas/api_schemas";
import { processIntervalsWebhook } from "../services.ts/process_intervals_event";
import { processStravaWebhook } from "../services.ts/process_strava_event";
import type { TPublicEnv } from "../types/IRouters";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { requireEnv } from "../utils";

const INTERVALS_WEBHOOK_SECRET = requireEnv("INTERVALS_WEBHOOK_SECRET");

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
    console.log("Strava handshake triggered");
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    const expectedToken = env.STRAVA_WEBHOOK_VERIFY_TOKEN;
    console.log(
      `Handshake - mode: ${mode}, token match: ${token === expectedToken}, challenge: ${challenge}`,
    );
    if (mode === "subscribe" && token === expectedToken) {
      return c.json({ "hub.challenge": challenge }, 200);
    }
    console.error("Verification failed: Token mismatch or invalid mode");
    return c.json({ error: "Verification failed" }, 403);
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
    console.log("Health triggered");
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

    console.log(
      `Strava event receivied: Type: ${body.aspect_type}, eventId: ${body.object_id} for athlete: ${body.owner_id}`,
    );
    if (body.subscription_id?.toString() !== env.STRAVA_SUBSCRIPTION_ID) {
      return c.json({ status: "unauthorized" }, 401);
    }
    processStravaWebhook(body, c.env).catch((err) =>
      console.error("Background processing failed:", err),
    );
    return c.json({ status: "ok" }, 200);
  },
);

const IntervalsActivityEventSchema = z.object({
  event: z.enum(["ACTIVITY_UPLOADED", "ACTIVITY_UPDATED", "ACTIVITY_ANALYZED", "ACTIVITY_DELETED"]),
  athlete_id: z.string(),
  activity_id: z.string(),
  secret: z.string(),
});

const IntervalsScopeChangeEventSchema = z.object({
  event: z.literal("APP_SCOPE_CHANGED"),
  athlete_id: z.string(),
  secret: z.string(),
});

const IntervalsWebhookEventSchema = z.discriminatedUnion("event", [
  IntervalsActivityEventSchema,
  IntervalsScopeChangeEventSchema,
]);

const IntervalsWebhookAckSchema = z.object({
  status: z.enum(["ok", "unauthorized"]),
});

publicRouter.post(
  "/intervals/event",
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
  validator("json", IntervalsWebhookEventSchema),
  async (c) => {
    const body: IIntervalsWebhookEvent = c.req.valid("json");

    const activitySuffix = "activity_id" in body ? `, activity: ${body.activity_id}` : "";
    console.log(
      `Intervals.icu event received: ${body.event} for athlete: ${body.athlete_id}${activitySuffix}`,
    );

    if (body.secret !== INTERVALS_WEBHOOK_SECRET) {
      console.warn(
        `Rejected intervals.icu webhook with bad secret (athlete: ${body.athlete_id}${activitySuffix})`,
      );
      return c.json({ status: "unauthorized" }, 401);
    }

    processIntervalsWebhook(body, c.env).catch((err) =>
      console.error("Intervals.icu webhook processing failed:", err),
    );
    return c.json({ status: "ok" }, 200);
  },
);

publicRouter.route("/", publicRouter);

export default publicRouter;
