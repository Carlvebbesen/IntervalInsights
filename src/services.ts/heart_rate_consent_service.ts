import { eq } from "drizzle-orm";
import { users } from "../schema";
import { IGlobalBindings } from "../types/IRouters";

export const userHasHeartRateConsent = async (
  db: IGlobalBindings["db"],
  userId: string,
): Promise<boolean> => {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { processHeartRate: true },
  });
  return row?.processHeartRate === true;
};
