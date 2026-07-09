import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { scriptRuns } from "../src/schema";
import { ONCE_SCRIPTS } from "./_registry";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function isCompleted(name: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(scriptRuns)
    .where(and(eq(scriptRuns.name, name), eq(scriptRuns.status, "completed")));
  return (row?.n ?? 0) > 0;
}

async function main() {
  const pending: string[] = [];
  for (const name of ONCE_SCRIPTS) {
    if (await isCompleted(name)) {
      console.log(`✓ ${name} — already completed, skipping`);
    } else {
      pending.push(name);
    }
  }
  await pool.end();

  if (pending.length === 0) {
    console.log("[run-pending] nothing to run — all run-once scripts already completed.");
    return;
  }

  console.log(`[run-pending] running ${pending.length} pending script(s): ${pending.join(", ")}`);
  for (const name of pending) {
    console.log(`\n──── ${name} ────`);
    const proc = Bun.spawn(["bun", "run", `scripts/${name}.ts`], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`[run-pending] ${name} exited ${code} — stopping.`);
      process.exit(code);
    }
  }
  console.log("\n[run-pending] done.");
}

main().catch(async (err) => {
  console.error("[run-pending] fatal:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
