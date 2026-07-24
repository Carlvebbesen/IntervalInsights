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
bun run scripts:status        # migrations + run-once + manually-run scripts
bun run scripts:status:once   # just the deploy gate: migrations + run-once
```

Read-only status against `DATABASE_URL` (the only variable either form needs):
every Drizzle migration (journal vs `drizzle.__drizzle_migrations`), every
run-once script (registry vs `script_runs`), and — unless `--once` is passed —
every manually-run script with its last run and run count. Manually-run scripts
have no pending state, but the harness records them all the same, and they are
otherwise invisible: `scripts:status:once` is the deploy gate, `scripts:status`
answers "what has actually been run in this database".

Both exit 1 when a migration or a run-once script is pending, so either can gate
another command. A `completed` run only means the body did not throw — a script
that skipped every candidate still records `completed`, so treat the run-once
ticks as "has run", not "was effective".

The report is built from the source, not a hand-kept list: every script wrapped
in `runScript(...)` is discovered (`_discover.ts`) and diffed against
`_registry.ts`. A `once: true` script missing from the registry is reported as
drift and exits 1 — without that check it would silently never run and never
appear as pending.

### Running all pending run-once scripts

```bash
bun run scripts:run        # == bun run scripts/run_pending.ts
```

Migration-style runner: checks `script_runs`, then runs only the run-once scripts that
haven't completed yet (in registry order), streaming each script's output and
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
