import { initTRPC } from "@trpc/server";
import { z } from "zod";

// Bruke postgres.js

// Sette opp migrasjoner
// Sette opp drizzler orm mot neon

type Env = {
  DB: any;
};
type HonoContext = {
  env: Env;
};

const t = initTRPC.context<HonoContext>().create();

const publicProcedure = t.procedure;
const router = t.router;

export const appRouter = router({
  hello: publicProcedure.input(z.string().nullish()).query(({ input, ctx }) => {
    console.log(
      `Fikk input fra apiet: ${input}: ${(Math.random() * 100).toFixed(0)}`
    );
    return `Hello ${input ?? "World"}!`;
  }),
});

export type AppRouter = typeof appRouter;
