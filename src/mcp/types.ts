import type { Logger } from "../logger";
import type { SelectUser } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

export type TMcpEnv = {
  Bindings: IGlobalBindings;
  Variables: {
    clerkUserId: string;
    userId: string;
    user: SelectUser;
    requestId: string;
    logger: Logger;
  };
};
