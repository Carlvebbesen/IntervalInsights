import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { analysisReviewModeEnum } from "./enums";
import { users } from "./users";

/**
 * Per-user analysis/notification preferences, split out from `users` (D-migration
 * target for `maxHeartRate`/`processHeartRate`). Lazily created on first access —
 * see `user_settings_repository.getOrCreateUserSettings` — so a missing row just
 * means "defaults", not "unset".
 */
export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  waitForStravaUpdate: boolean("wait_for_strava_update").notNull().default(true),
  analysisReviewMode: analysisReviewModeEnum("analysis_review_mode").notNull().default("all"),
  maxHeartRate: integer("max_heart_rate"),
  processHeartRate: boolean("process_heart_rate").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));

export type InsertUserSettings = InferInsertModel<typeof userSettings>;
export type SelectUserSettings = InferSelectModel<typeof userSettings>;
