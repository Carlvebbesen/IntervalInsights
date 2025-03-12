import { pgEnum, pgTable } from "drizzle-orm/pg-core";
import * as t from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const rolesEnum = pgEnum("roles", ["guest", "user", "admin"]);

export const User = pgTable("user", {
  id: t.uuid().notNull().primaryKey().defaultRandom(),
  firstName: t.varchar("first_name", { length: 256 }),
  lastName: t.varchar("last_name", { length: 256 }),
  email: t.varchar().notNull(),
  role: rolesEnum().default("guest"),
});

export const CreateUserSchema = createInsertSchema(User).omit({
  id: true,
  role: true,
});
