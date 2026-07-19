import { createMiddleware } from "hono/factory";
import { AppError } from "../error";
import { type Logger, logger as rootLogger } from "../logger";
import type { TGlobalEnv } from "../types/IRouters";

export const SUGGEST_SESSION_QUOTA = "suggest-session";
export const PARSE_INTERVALS_QUOTA = "parse-intervals";
export const ANALYSIS_START_QUOTA = "analysis-start";
export const PLAN_BUILDER_QUOTA = "plan-builder";

export const SUGGEST_SESSION_DAILY_MAX = 100;
export const PARSE_INTERVALS_DAILY_MAX = 100;
export const ANALYSIS_START_DAILY_MAX = 1000;
export const PLAN_BUILDER_DAILY_MAX = 40;

interface QuotaEntry {
  day: string;
  count: number;
}

const stores = new Map<string, Map<string, QuotaEntry>>();

let clock: () => Date = () => new Date();
const utcDay = (): string => clock().toISOString().slice(0, 10);

function bump(name: string, userId: string): number {
  let store = stores.get(name);
  if (!store) {
    store = new Map();
    stores.set(name, store);
  }
  const day = utcDay();
  const entry = store.get(userId);
  if (!entry || entry.day !== day) {
    store.set(userId, { day, count: 1 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function warnApproaching(name: string, userId: string, count: number, max: number, log: Logger) {
  if (count === Math.ceil(max * 0.8)) {
    log.warn({ quota: name, userId, count, max }, "user approaching daily quota");
  }
}

export function consumeQuota(name: string, max: number, userId: string, log: Logger = rootLogger) {
  const count = bump(name, userId);
  if (count > max) {
    throw new AppError(429, "Daily limit reached — please try again tomorrow.");
  }
  warnApproaching(name, userId, count, max, log);
}

export function tryConsumeQuota(
  name: string,
  max: number,
  userId: string,
  log: Logger = rootLogger,
): boolean {
  const count = bump(name, userId);
  if (count > max) {
    log.warn({ quota: name, userId, count, max }, "daily quota exceeded — skipping");
    return false;
  }
  warnApproaching(name, userId, count, max, log);
  return true;
}

export function dailyQuota(name: string, max: number) {
  return createMiddleware<TGlobalEnv>(async (c, next) => {
    const userId = c.get("userId");
    if (userId) consumeQuota(name, max, userId, c.var.logger);
    await next();
  });
}

export function __resetQuotaStore() {
  stores.clear();
}
export function __setClock(fn: (() => Date) | null) {
  clock = fn ?? (() => new Date());
}
export function __peekQuota(name: string, userId: string): number {
  return stores.get(name)?.get(userId)?.count ?? 0;
}
