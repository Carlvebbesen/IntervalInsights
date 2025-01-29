import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL ?? "NO_DATABASE_STRING";
console.log(connectionString);
export const db = drizzle({
  connection: connectionString,
  schema,
  casing: "snake_case",
});
