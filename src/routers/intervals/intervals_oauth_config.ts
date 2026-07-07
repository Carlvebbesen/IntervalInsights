import { config } from "../../config";

export const INTERVALS_CLIENT_ID = config.INTERVALS_CLIENT_ID;
export const INTERVALS_CLIENT_SECRET = config.INTERVALS_CLIENT_SECRET;
// Externally pinned in the intervals.icu app registration — non-prod deploys must register their own callback.
export const INTERVALS_REDIRECT_URI = new URL(
  "/intervals-callback",
  config.APP_BASE_URL,
).toString();
export const INTERVALS_SCOPES = "ACTIVITY:READ,WELLNESS:READ,SETTINGS:READ";
export const INTERVALS_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";
