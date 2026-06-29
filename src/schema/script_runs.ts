import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { scriptRunStatusEnum } from "./enums";

export const scriptRuns = pgTable(
  "script_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    status: scriptRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
  },
  (table) => [index("script_runs_name_status_idx").on(table.name, table.status)],
);

export type InsertScriptRun = InferInsertModel<typeof scriptRuns>;
export type SelectScriptRun = InferSelectModel<typeof scriptRuns>;
