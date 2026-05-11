import { env } from "bun";

function requireEnv(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const INTERVALS_CLIENT_ID = requireEnv("INTERVALS_CLIENT_ID");
export const INTERVALS_CLIENT_SECRET = requireEnv("INTERVALS_CLIENT_SECRET");
export const INTERVALS_REDIRECT_URI = "https://intervalinsights.cvebbesen.no/intervals-callback";
export const INTERVALS_SCOPES = "ACTIVITY:READ,WELLNESS:READ";
export const INTERVALS_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";
