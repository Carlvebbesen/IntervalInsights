import type { Logger } from "../logger";
import type { SelectUser } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

export type TMcpEnv = {
  Bindings: IGlobalBindings;
  Variables: {
    userId: string;
    user: SelectUser;
    scopes: string[];
    requestId: string;
    logger: Logger;
  };
};
