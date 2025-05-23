import { db } from "@intervalinsights/db";
import { initTRPC } from "@trpc/server";
import { SuperJSON } from "superjson";
import { ZodError } from "zod";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
  // const authToken = opts.headers.get("Authorization") ?? null;
  return {
    db,
    token: "authToken",
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: SuperJSON,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
    },
  }),
});
export const createTRPCRouter = t.router;

const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();

  if (t._config.isDev) {
    // artificial delay in dev 100-500ms
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const end = Date.now();
  console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

  return result;
});

export const publicProcedure = t.procedure.use(timingMiddleware);

export const protectedProcedure = t.procedure.use(timingMiddleware);
// .use(({ ctx, next }) => {
//   if (!ctx.session?.user) {
//     throw new TRPCError({ code: "UNAUTHORIZED" });
//   }
//   return next({
//     ctx: {
//       // infers the `session` as non-nullable
//       session: { ...ctx.session, user: ctx.session.user },
//     },
//   });
// });
