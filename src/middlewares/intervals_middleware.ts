import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { env } from "bun";
import { IntervalsError } from "../error";
import type { TIntervalsEnv } from "../types/IRouters";

function isIntervalsMetadata(value: unknown): value is { api_key: string } {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.api_key === "string" && record.api_key.length > 0;
}

function extractApiKey(metadata: Record<string, unknown>): string | null {
  const intervals = metadata.intervals;
  if (isIntervalsMetadata(intervals)) {
    return intervals.api_key;
  }
  return null;
}

export const getIntervalsApiKey = async (clerkUserId: string): Promise<string> => {
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const user = await clerkClient.users.getUser(clerkUserId);
  const apiKey = extractApiKey(user.privateMetadata);
  if (!apiKey) {
    throw new IntervalsError(403, "Intervals.icu account not linked");
  }
  return apiKey;
};

export const intervalsMiddleware = createMiddleware<TIntervalsEnv>(async (c, next) => {
  const clerkUserId = c.get("clerkUserId");
  const apiKey = await getIntervalsApiKey(clerkUserId);
  c.set("intervalsApiKey", apiKey);
  await next();
});
