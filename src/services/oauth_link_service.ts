import { eq } from "drizzle-orm";
import { config } from "../config";
import { AppError, IntervalsError } from "../error";
import type { Logger } from "../logger";
import {
  INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET,
  INTERVALS_REDIRECT_URI,
  INTERVALS_TOKEN_URL,
} from "../routers/intervals/intervals_oauth_config";
import { type OAuthProvider, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsTokenResponse } from "../types/intervals/IIntervalsAuth";
import { intervalsApiService } from "./intervals_api_service";
import { type StoredOAuthToken, writeProviderToken } from "./oauth_token_store";

type Db = IGlobalBindings["db"];

/**
 * The shared shape of linking an OAuth provider account: exchange the
 * authorization code for tokens, persist the provider athlete id on the user
 * row, then store the tokens encrypted in `oauth_provider_tokens` keyed by the
 * internal user id.
 */
interface OAuthProviderLink<TAthleteId extends string | number> {
  provider: OAuthProvider;
  displayName: string;
  request: { url: string; init: RequestInit };
  /** Provider-specific handling of a non-2xx token response. Must throw. */
  onExchangeFailure(response: Response, logger: Logger): Promise<never>;
  resolveLink(tokenData: unknown): Promise<{ token: StoredOAuthToken; athleteId: TAthleteId }>;
  /** Persist the provider athlete id on the user row (`users.id = userId`). */
  persistUserLink(db: Db, userId: string, athleteId: TAthleteId, logger: Logger): Promise<void>;
}

async function linkProviderAccount<TAthleteId extends string | number>(
  db: Db,
  userId: string,
  spec: OAuthProviderLink<TAthleteId>,
  logger: Logger,
): Promise<void> {
  const tokenResponse = await fetch(spec.request.url, spec.request.init);
  if (!tokenResponse.ok) {
    await spec.onExchangeFailure(tokenResponse, logger);
  }
  const tokenData = await tokenResponse.json();

  const { token, athleteId } = await spec.resolveLink(tokenData);
  await spec.persistUserLink(db, userId, athleteId, logger);
  await writeProviderToken(db, userId, spec.provider, token);

  logger.info({ userId, athleteId }, `Linked ${spec.displayName} account`);
}

type StravaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: { id: number };
};

export function linkStravaAccount(
  db: Db,
  userId: string,
  code: string,
  logger: Logger,
): Promise<void> {
  return linkProviderAccount(
    db,
    userId,
    {
      provider: "strava",
      displayName: "Strava",
      request: {
        url: "https://www.strava.com/oauth/token",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: config.STRAVA_CLIENT_ID,
            client_secret: config.STRAVA_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
          }),
        },
      },
      async onExchangeFailure(response, log) {
        const tokenData = await response.json().catch(() => ({ message: response.statusText }));
        log.error({ tokenData }, "Strava token exchange failed");
        throw new AppError(401, "Failed to exchange token with Strava");
      },
      async resolveLink(tokenData) {
        const data = tokenData as StravaTokenResponse;
        return {
          token: {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_at,
            athlete_id: String(data.athlete.id),
          },
          athleteId: data.athlete.id,
        };
      },
      async persistUserLink(dbc, linkUserId, athleteId, log) {
        const stravaId = String(athleteId);
        const existingUser = await dbc.query.users.findFirst({
          where: eq(users.id, linkUserId),
        });
        if (!existingUser) throw new AppError(404, "User not found");
        if (!existingUser.stravaId) {
          await dbc.update(users).set({ stravaId }).where(eq(users.id, linkUserId));
          log.info({ userId: linkUserId }, "Updated Strava ID for existing user");
        }
      },
    },
    logger,
  );
}

export function linkIntervalsAccount(
  db: Db,
  userId: string,
  code: string,
  logger: Logger,
): Promise<void> {
  return linkProviderAccount(
    db,
    userId,
    {
      provider: "intervals",
      displayName: "Intervals.icu",
      request: {
        url: INTERVALS_TOKEN_URL,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: INTERVALS_CLIENT_ID,
            client_secret: INTERVALS_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: INTERVALS_REDIRECT_URI,
          }),
        },
      },
      async onExchangeFailure(response, log) {
        const errorBody = await response.json().catch(() => ({ message: response.statusText }));
        log.error({ errorBody }, "Intervals.icu token exchange failed");
        throw new IntervalsError(401, "Failed to exchange code with Intervals.icu");
      },
      async resolveLink(tokenData) {
        const data = tokenData as IIntervalsTokenResponse;
        const nowSecs = Math.floor(Date.now() / 1000);
        const athlete =
          data.athlete_id != null
            ? { id: data.athlete_id }
            : await intervalsApiService.getAthlete(data.access_token);
        return {
          token: {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_in != null ? nowSecs + data.expires_in : undefined,
            athlete_id: String(athlete.id),
          },
          athleteId: athlete.id,
        };
      },
      async persistUserLink(dbc, linkUserId, athleteId) {
        const [updated] = await dbc
          .update(users)
          .set({ intervalsAthleteId: athleteId })
          .where(eq(users.id, linkUserId))
          .returning({ id: users.id });
        if (!updated) throw new AppError(404, "User not found");
      },
    },
    logger,
  );
}
