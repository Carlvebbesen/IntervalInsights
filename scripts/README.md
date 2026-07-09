# Scripts

One-off and maintenance scripts, run with `bun run scripts/<file>.ts`.

## Run tracking (`_harness.ts`)

Every script that touches the database is wrapped in `runScript(...)`, which records
each invocation in the `script_runs` table (one row per run: status, start/finish,
duration, error). This answers "what scripts have run in production, and how often".

```ts
import { runScript } from "./_harness";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  // ...work. Do NOT call pool.end() — the harness owns the pool lifecycle.
}

runScript({ name: "my_script", once: false, db, pool }, main);
```

- `name` — stable identifier (use the file basename).
- `once: true` — migration-like guard: if a completed run already exists, the script
  logs and exits 0 without running again. Use for one-time data backfills.
- On failure the body should `throw` (the harness records `status = 'failed'` and exits 1).

### Checking what's pending on the current DB

```bash
bun run scripts:status     # == bun run scripts/status.ts
```

Read-only status against `DATABASE_URL`: lists every Drizzle migration
(journal vs `drizzle.__drizzle_migrations`) and every run-once script
(registry vs `script_runs`) with applied/pending state. Exits 1 when anything
is pending, so it can gate other commands.

### Running all pending run-once scripts

```bash
bun run scripts:run        # == bun run scripts/run_pending.ts
```

Migration-style runner: checks `script_runs`, then runs only the run-once scripts that
haven't completed yet (in order, clerk sync last), streaming each script's output and
stopping on the first failure. Already-completed scripts are skipped. The ordered registry
lives in `scripts/_registry.ts` (shared with `status.ts`) — keep it in sync with the
`once: true` scripts. This is a manual command; it is **not** wired into deploy
(deploy runs only `db:migrate`).

### Baselining already-run scripts

When introducing tracking for a script that has *already* run in production, record a
completed run without executing the body:

```bash
MARK_COMPLETE=1 bun run scripts/<file>.ts
```

This inserts a `completed` row tagged `meta.baseline = true`, so a subsequent
`once: true` invocation correctly skips.

### Pure-compute scripts

`ab_model`, `audit_classify`, `classify_check`, `diag_cascade`, `diag_segments`, and
`grade_segments` have no database connection (fixtures / local analysis) and are not tracked.
