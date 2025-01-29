import { desc } from "@intervalinsights/db";
import { CreateUserSchema, User } from "@intervalinsights/db/schema";
import { publicProcedure } from "../trpc";

export const userRouter = {
  all: publicProcedure.query(({ ctx }) => {
    console.log("All procedure called");
    return ctx.db.query.User.findMany({
      orderBy: desc(User.id),
    });
  }),
  create: publicProcedure.input(CreateUserSchema).mutation(({ ctx, input }) => {
    return ctx.db.insert(User).values(input);
  }),
};
