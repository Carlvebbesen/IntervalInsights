import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "./config";
import * as schema from "./schema";

export const pool = new Pool({ connectionString: config.DATABASE_URL });
export const db = drizzle({ client: pool, schema });
