import { desc } from "@intervalinsights/db";
import { publicProcedure } from "../trpc";
import type { TRPCRouterRecord } from "@trpc/server";
import { CreateUserSchema, User } from "@intervalinsights/db";

export const userRouter = {
  all: publicProcedure.query(async ({ ctx }) => {
    console.log("All procedure called");
    console.log("heheh");
    const users = await ctx.db.query.User.findMany({
      orderBy: desc(User.lastName),
    });
    console.log(users);
    return users ?? [];
  }),
  create: publicProcedure.input(CreateUserSchema).mutation(({ ctx, input }) => {
    console.log(input);
    return ctx.db.insert(User).values(input);
  }),
} satisfies TRPCRouterRecord;
