import { findOrCreateUserSettings } from "../repositories/user_settings_repository";
import type { IGlobalBindings } from "../types/IRouters";

/** A webhook racing an account deletion must be a graceful no-consent skip,
 * not a thrown error into ingest — so a missing user resolves to false. */
export const userHasHeartRateConsent = async (
  db: IGlobalBindings["db"],
  userId: string,
): Promise<boolean> => {
  const settings = await findOrCreateUserSettings(db, userId);
  return settings?.processHeartRate === true;
};
