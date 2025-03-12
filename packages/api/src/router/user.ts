import { desc } from "@intervalinsights/db";
import { CreateUserSchema, User } from "@intervalinsights/db/schema";
import { publicProcedure } from "../trpc";

export const userRouter = {
  all: publicProcedure.query(async ({ ctx }) => {
    console.log("All procedure called");
    console.log(ctx.db);
    const hei = await ctx.db.query.User.findMany({
      orderBy: desc(User.id),
    });
    console.log("hie");
    return hei;
  }),
  create: publicProcedure.input(CreateUserSchema).mutation(({ ctx, input }) => {
    console.log(input);
    return ctx.db.insert(User).values(input);
  }),
};
