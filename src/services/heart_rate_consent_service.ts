import { getOrCreateUserSettings } from "../repositories/user_settings_repository";
import type { IGlobalBindings } from "../types/IRouters";

export const userHasHeartRateConsent = async (
  db: IGlobalBindings["db"],
  userId: string,
): Promise<boolean> => {
  const settings = await getOrCreateUserSettings(db, userId);
  return settings.processHeartRate === true;
};
