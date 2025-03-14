import { desc } from "@intervalinsights/db";
import { CreateUserSchema, User } from "@intervalinsights/db/schema";
import { publicProcedure } from "../trpc";
import { TRPCRouterRecord } from "@trpc/server";

export const userRouter = {
  all: publicProcedure.query(async ({ ctx }) => {
    console.log("All procedure called");
    console.log(ctx.db);
    return ctx.db.query.User.findMany({
      orderBy: desc(User.id),
    });
  }),
  create: publicProcedure.input(CreateUserSchema).mutation(({ ctx, input }) => {
    console.log(input);
    return ctx.db.insert(User).values(input);
  }),
} satisfies TRPCRouterRecord;
