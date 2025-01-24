// import { Stack } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { trpc, queryClient, trpcClient } from "../utils/trpc"; // Adjust path
import App from "./"; // Your main app component

const Root = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <App />
      </trpc.Provider>
    </QueryClientProvider>
  );
};

export default Root;
