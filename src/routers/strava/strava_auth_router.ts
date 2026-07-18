import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import z from "zod";
import { config } from "../../config";
import { AppError } from "../../error";
import { errJson, okJson } from "../../schemas/route_helpers";
import { linkStravaAccount } from "../../services/oauth_link_service";
import { isReviewUser } from "../../services/review_account";
import type { TGlobalEnv } from "../../types/IRouters";

const stravaAuthRouter = new Hono<TGlobalEnv>();

const REDIRECT_URI = new URL("/strava-callback", config.APP_BASE_URL).toString();

const STRAVA_CLIENT_ID = config.STRAVA_CLIENT_ID;

const StravaAuthUrlResponseSchema = z.object({
  url: z.string().url(),
});

const StravaExchangeBodySchema = z.object({
  code: z.string(),
});

const StravaExchangeResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

stravaAuthRouter.get(
  "/url",
  describeRoute({
    description:
      "Build the Strava OAuth authorization URL the client should redirect the user to. Always returns the same URL pattern for the configured client.",
    responses: {
      200: okJson(StravaAuthUrlResponseSchema, "Authorization URL"),
    },
  }),
  (c) => {
    const params = new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      approval_prompt: "force",
      scope: "read,read_all,activity:read_all",
    });

    return c.json({
      url: `https://www.strava.com/oauth/mobile/authorize?${params.toString()}`,
    });
  },
);

stravaAuthRouter.post(
  "/exchange",
  describeRoute({
    description:
      "Exchange a Strava OAuth `code` for tokens, store them encrypted in the token vault, and link the Strava athlete to the authenticated user.",
    responses: {
      200: okJson(StravaExchangeResponseSchema, "Strava account linked"),
      400: errJson("Missing authorization code"),
      401: errJson("Strava rejected the code"),
      409: errJson("Strava account already linked to another user"),
      500: errJson("Internal server error"),
    },
  }),
  validator("json", StravaExchangeBodySchema),
  async (c) => {
    const userId = c.get("userId");
    // A disconnect/reconnect would null the demo user's stravaId sentinel and
    // re-strand the app-store reviewer behind the connect gate — reject both.
    if (isReviewUser(userId)) {
      throw new AppError(403, "The demo account cannot link a Strava account.");
    }
    const { code } = c.req.valid("json");
    await linkStravaAccount(c.env.db, userId, code, c.var.logger);

    return c.json({
      success: true,
      message: "Strava connected successfully.",
    });
  },
);

export default stravaAuthRouter;
