import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { userRoleEnum } from "./enums";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
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
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
  },
  (t) => [
    index("users_last_seen_at_idx").on(t.lastSeenAt),
    index("users_created_at_idx").on(t.createdAt),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  activities: many(activities),
}));

export type InsertUser = InferInsertModel<typeof users>;
export type SelectUser = InferSelectModel<typeof users>;
