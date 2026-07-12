import { trace } from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";
import { AppError } from "../error";
import type { TGlobalEnv } from "../types/IRouters";

export function clientKeyGuard(opts: { key?: string; mode: "log" | "enforce" }) {
  return createMiddleware<TGlobalEnv>(async (c, next) => {
    if (!opts.key) return next();

    const provided = c.req.header("x-client-key");
    if (provided === opts.key) return next();

    trace.getActiveSpan()?.setAttribute("client_key.valid", false);
    if (opts.mode === "enforce") {
      throw new AppError(401, "Unauthorized");
    }
    c.var.logger.warn(
      { path: c.req.path, hasClientKey: provided != null },
      "client key missing or invalid",
    );
    return next();
  });
}
