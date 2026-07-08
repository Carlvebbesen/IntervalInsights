import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { userRoleEnum } from "./enums";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Legacy Clerk identity key, nullable during the dual-auth window (Better
  // Auth users never get one). Dropped in Phase 6.
  clerkId: text("clerk_id").unique(),
  // Better Auth core columns. email/name stay nullable until the Phase 3
  // backfill lands and the Phase 6 cutover tightens them — Better Auth's own
  // sign-in path always supplies both, so the looser DB constraint is safe.
  email: text("email").unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  image: text("image"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  stravaId: text("strava_id").unique(),
  createdAt: timestamp("created_at").defaultNow(),
  role: userRoleEnum("role").default("guest"),
  maxHeartRate: integer("max_heart_rate"),
  processHeartRate: boolean("process_heart_rate").notNull().default(false),
  privacyPolicyAcceptedAt: timestamp("privacy_policy_accepted_at"),
  privacyPolicyVersion: text("privacy_policy_version"),
  termsOfServiceAcceptedAt: timestamp("terms_of_service_accepted_at"),
  termsOfServiceVersion: text("terms_of_service_version"),
  intervalsAthleteId: text("intervals_athlete_id").unique(),
  lastSeenAt: timestamp("last_seen_at"),
});

export const usersRelations = relations(users, ({ many }) => ({
  activities: many(activities),
}));

export type InsertUser = InferInsertModel<typeof users>;
export type SelectUser = InferSelectModel<typeof users>;
