import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer } from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { userRoleEnum } from "./enums";


export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkId: text('clerk_id').unique().notNull(),
  stravaId: text('strava_id').unique(),
  createdAt: timestamp('created_at').defaultNow(),
  role: userRoleEnum("role").default("guest"),
  maxHeartRate: integer("max_heart_rate")
});

export const usersRelations = relations(users, ({ many }) => ({
  activities: many(activities),
}));