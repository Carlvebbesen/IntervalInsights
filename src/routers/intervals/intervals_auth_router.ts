import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import z from "zod";
import { errJson, okJson } from "../../schemas/route_helpers";
import { disconnectIntervals } from "../../services/intervals_link_service";
import { linkIntervalsAccount } from "../../services/oauth_link_service";
import type { TGlobalEnv } from "../../types/IRouters";
import {
  INTERVALS_AUTHORIZE_URL,
  INTERVALS_CLIENT_ID,
  INTERVALS_REDIRECT_URI,
  INTERVALS_SCOPES,
} from "./intervals_oauth_config";

const intervalsAuthRouter = new Hono<TGlobalEnv>();

const ExchangeBodySchema = z.object({
  code: z.string(),
});

const IntervalsAuthUrlResponseSchema = z.object({
  url: z.string().url(),
});

const IntervalsSuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

const IntervalsStatusResponseSchema = z.object({
  connected: z.boolean(),
});

intervalsAuthRouter.get(
  "/url",
  describeRoute({
    description:
      "Build the intervals.icu OAuth authorization URL the client should redirect the user to.",
    responses: {
      200: okJson(IntervalsAuthUrlResponseSchema, "Authorization URL"),
    },
  }),
  (c) => {
    const params = new URLSearchParams({
      client_id: INTERVALS_CLIENT_ID,
      redirect_uri: INTERVALS_REDIRECT_URI,
      response_type: "code",
      scope: INTERVALS_SCOPES,
    });

    return c.json({
      url: `${INTERVALS_AUTHORIZE_URL}?${params.toString()}`,
    });
  },
);

intervalsAuthRouter.post(
  "/exchange",
  describeRoute({
    description:
      "Exchange an intervals.icu OAuth `code` for tokens, store them in Clerk private metadata, and link the intervals.icu athlete to the authenticated user.",
    responses: {
      200: okJson(IntervalsSuccessResponseSchema, "Intervals.icu account linked"),
      400: errJson("Missing authorization code"),
      401: errJson("intervals.icu rejected the code"),
    },
  }),
  validator("json", ExchangeBodySchema),
  async (c) => {
    const userId = c.get("userId");
    const { code } = c.req.valid("json");
    await linkIntervalsAccount(c.env.db, userId, code, c.var.logger);

    return c.json({
      success: true,
      message: "Intervals.icu connected successfully.",
    });
  },
);

intervalsAuthRouter.post(
  "/disconnect",
  describeRoute({
    description:
      "Disconnect intervals.icu: remove the stored tokens from Clerk private metadata and clear the athlete link on the user row.",
    responses: {
      200: okJson(IntervalsSuccessResponseSchema, "Intervals.icu disconnected"),
    },
  }),
  async (c) => {
    const userId = c.get("userId");
    await disconnectIntervals(c.env, userId);
    c.var.logger.info({ userId }, "Disconnected Intervals.icu");

    return c.json({
      success: true,
      message: "Intervals.icu disconnected.",
    });
  },
);

intervalsAuthRouter.get(
  "/status",
  describeRoute({
    description: "Whether the authenticated user has an intervals.icu account linked.",
    responses: {
      200: okJson(IntervalsStatusResponseSchema, "Connection state"),
    },
  }),
  (c) => {
    const connected = c.var.user.intervalsAthleteId != null;
    return c.json({ connected });
  },
);

export default intervalsAuthRouter;
