import { initTRPC } from "@trpc/server";
import { db } from "@intervalinsights/db/client";

export const createTRPCContext = async (opts: {
  headers: Headers;
  session: String | null;
}) => {
  const authToken = opts.headers.get("Authorization") ?? null;
  return {
    db,
    token: authToken,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

export const createTRPCRouter = t.router;

export const publicProcedure = t.procedure;
