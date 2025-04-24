import { Stack } from "expo-router";
import { TRPCProvider } from "@/utils/trpc";
import { StatusBar } from "expo-status-bar";

const Root = () => {
  return (
    <TRPCProvider>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="+not-found" />
      </Stack>
      <StatusBar style="auto" />
    </TRPCProvider>
  );
};

export default Root;
