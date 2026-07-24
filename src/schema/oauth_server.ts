import type { InferSelectModel } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./auth_tables";
import { users } from "./users";

export const jwks = pgTable("jwks", {
  id: uuid("id").defaultRandom().primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    public: boolean("public"),
    type: text("type"),
    requirePKCE: boolean("require_pkce"),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_clients_user_id_idx").on(t.userId)],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    revoked: timestamp("revoked"),
    authTime: timestamp("auth_time"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_refresh_tokens_client_id_idx").on(t.clientId),
    index("oauth_refresh_tokens_session_id_idx").on(t.sessionId),
    index("oauth_refresh_tokens_user_id_idx").on(t.userId),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    refreshId: uuid("refresh_id").references(() => oauthRefreshTokens.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_access_tokens_client_id_idx").on(t.clientId),
    index("oauth_access_tokens_session_id_idx").on(t.sessionId),
    index("oauth_access_tokens_user_id_idx").on(t.userId),
    index("oauth_access_tokens_refresh_id_idx").on(t.refreshId),
  ],
);

export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("oauth_consents_client_id_idx").on(t.clientId),
    index("oauth_consents_user_id_idx").on(t.userId),
  ],
);

export type OAuthClientRow = InferSelectModel<typeof oauthClients>;
export type OAuthAccessTokenRow = InferSelectModel<typeof oauthAccessTokens>;
