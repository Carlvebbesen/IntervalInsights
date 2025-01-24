import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../packages/api";
import { httpBatchLink } from "@trpc/client";
import { QueryClient } from "@tanstack/react-query";

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/trpc",
    }),
  ],
});

export const queryClient = new QueryClient();
