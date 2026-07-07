import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { activities } from "./activities";

// A structure is a pure workout SHAPE, keyed by its canonical signature. The
// user-confirmed training type lives on the activity, not here — a shape can be
// run under different training types over time.
export const intervalStructures = pgTable("interval_structures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  signature: text("signature").unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const intervalStructuresRelations = relations(intervalStructures, ({ many }) => ({
  activities: many(activities),
}));

export type InsertIntervalStructure = InferInsertModel<typeof intervalStructures>;
export type SelectIntervalStructure = InferSelectModel<typeof intervalStructures>;
