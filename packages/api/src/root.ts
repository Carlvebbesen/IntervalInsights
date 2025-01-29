import { userRouter } from "./router/user";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  userRouter,
});

export type AppRouter = typeof appRouter;
