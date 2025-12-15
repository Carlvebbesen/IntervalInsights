import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema'; // This imports everything from schema/index.ts
import postgres = require('postgres');

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

// Pass the schema object so query builders work (db.query.users...)
export const db = drizzle(client, { schema });