import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";

import type { AppRouter } from "@intervalinsights/api";

// import * as SecureStore from "expo-secure-store";

// const key = "session_token";
// export const getToken = () => SecureStore.getItem(key);
// export const deleteToken = () => SecureStore.deleteItemAsync(key);
// export const setToken = (v: string) => SecureStore.setItem(key, v);

export const api = createTRPCReact<AppRouter>();

export function TRPCProvider(props: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === "development" ||
            (opts.direction === "down" && opts.result instanceof Error),
          colorMode: "ansi",
        }),
        httpBatchLink({
          url: `http://localhost:3000/trpc`,
          headers() {
            const headers = new Map<string, string>();

            // const token = getToken();
            // if (token) headers.set("Authorization", `Bearer ${token}`);

            return Object.fromEntries(headers);
          },
        }),
      ],
    })
  );

  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    </api.Provider>
  );
}
