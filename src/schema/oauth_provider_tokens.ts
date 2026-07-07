import { type InferSelectModel, relations } from "drizzle-orm";
import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { oauthProviderEnum } from "./enums";
import { users } from "./users";

/**
 * Third-party (Strava / intervals.icu) OAuth tokens, keyed by the internal
 * `users.id`. Replaces the Clerk `privateMetadata` token vault. `accessToken` and
 * `refreshToken` hold ciphertext (better-auth/crypto, key `TOKEN_ENC_KEY`) — never
 * plaintext. One row per (user, provider); the row is deleted on unlink/deauth and
 * cascades away with the user.
 */
export const oauthProviderTokens = pgTable(
  "oauth_provider_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: oauthProviderEnum("provider").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at"),
    athleteId: text("athlete_id"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("oauth_provider_tokens_user_provider_unique").on(t.userId, t.provider)],
);

export const oauthProviderTokensRelations = relations(oauthProviderTokens, ({ one }) => ({
  user: one(users, {
    fields: [oauthProviderTokens.userId],
    references: [users.id],
  }),
}));

export type OAuthProviderTokenRow = InferSelectModel<typeof oauthProviderTokens>;
