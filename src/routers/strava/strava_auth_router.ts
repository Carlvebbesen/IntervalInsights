import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import z from "zod";
import { config } from "../../config";
import { errJson, okJson } from "../../schemas/route_helpers";
import { linkStravaAccount } from "../../services/oauth_link_service";
import type { TGlobalEnv } from "../../types/IRouters";

const stravaAuthRouter = new Hono<TGlobalEnv>();

// Externally pinned in the Strava app registration — non-prod deploys must register their own callback.
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
      500: errJson("Internal server error"),
    },
  }),
  validator("json", StravaExchangeBodySchema),
  async (c) => {
    const { code } = c.req.valid("json");
    await linkStravaAccount(c.env.db, c.get("userId"), code, c.var.logger);

    return c.json({
      success: true,
      message: "Strava connected successfully.",
    });
  },
);

export default stravaAuthRouter;
