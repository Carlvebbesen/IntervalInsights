// import { Stack } from "expo-router";
import App from ".";
import { TRPCProvider } from "@/utils/trpc";

const Root = () => {
  return (
    <TRPCProvider>
      <App />
    </TRPCProvider>
  );
};

export default Root;
