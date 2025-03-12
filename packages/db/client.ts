import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./src/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("No database url set for the environment");
}
export const db = drizzle({
  connection: connectionString,
  schema,
  casing: "snake_case",
});
