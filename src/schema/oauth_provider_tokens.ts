import { type InferSelectModel, relations } from "drizzle-orm";
import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { oauthProviderEnum } from "./enums";
import { users } from "./users";

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
