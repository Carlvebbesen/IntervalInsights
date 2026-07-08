import { trace } from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";
import { AppError } from "../error";
import type { TGlobalEnv } from "../types/IRouters";

/**
 * App client key — deterrence-only (Clerk-publishable-key pattern). The app
 * ships a shared secret and sends it as `x-client-key`; a non-app client using
 * the backend as a free API has to extract it from the binary first. Nothing
 * here *proves* app origin (only device attestation could) — it's accepted
 * friction, not authentication.
 *
 * `key` unset ⇒ feature fully off (dev/tests, and prod until the key is set).
 * `mode: "log"` warns on a missing/wrong key and lets the request through (the
 * rollout phase, while already-installed builds send no header); `mode:
 * "enforce"` 401s. Mounted on `/api/*` after the public routes so webhooks,
 * health, and legal stay open, and before the Better Auth handler so even OTP
 * send/verify requires the key. `/mcp` is a different prefix and is exempt.
 */
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
