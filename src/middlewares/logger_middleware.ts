import { MiddlewareHandler } from 'hono';

export const debugLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req;

    console.log(`[DEBUG] ➔ Incoming: ${method} ${url}`);

    await next();

    const ms = Date.now() - start;
    console.log(`[DEBUG] ⬅︎ Finished: ${method} ${url} (${c.res.status}) - ${ms}ms`);
  };
};