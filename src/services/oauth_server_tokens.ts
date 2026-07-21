import { createHash } from "node:crypto";
import { config } from "../config";

export const MCP_RESOURCE_URL = new URL("/mcp", config.APP_BASE_URL).toString();

export const AUTH_ISSUER = `${config.BETTER_AUTH_URL.replace(/\/$/, "")}/api/auth`;

export const MCP_SCOPES = ["profile", "email", "offline_access"] as const;

export const OAUTH_LOGIN_PAGE = "/oauth/sign-in";
export const OAUTH_CONSENT_PAGE = "/oauth/consent";

export function hashOAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function protectedResourceMetadataUrl(): string {
  return new URL("/.well-known/oauth-protected-resource/mcp", config.APP_BASE_URL).toString();
}
