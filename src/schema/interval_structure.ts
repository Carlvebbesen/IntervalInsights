import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { intervalTypeEnum, trainingTypeEnum } from "./enums";

export const intervalStructures = pgTable("interval_structures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  signature: text("signature").unique(),
  trainingType: trainingTypeEnum("training_type").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  intervalType: intervalTypeEnum("interval_type"),
});

export const intervalStructuresRelations = relations(intervalStructures, ({ many }) => ({
  activities: many(activities),
}));

export type InsertIntervalStructure = InferInsertModel<typeof intervalStructures>;
export type SelectIntervalStructure = InferSelectModel<typeof intervalStructures>;
