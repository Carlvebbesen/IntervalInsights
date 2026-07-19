# Before merging `event-lifecycle`

Written 2026-07-20. Delete this file as part of the merge.

Branch state at the time of writing: 2 commits ahead of `origin/main`, 0 behind,
clean tree, `origin/main` already merged in. Nothing here is a defect in the
branch — it is purely about the order in which this lands relative to
`admin-console`, because all worktrees share one dev database.

## Why this branch needs a sequence at all

`0036_drop_events_description.sql` is **destructive** (`ALTER TABLE events DROP
COLUMN description`). Every `interval-insights` worktree copies its `.env` from
the base checkout, so they all point at the same dev database
(`interval_insights_dev`). The moment `db:migrate` runs here, the column is gone
for *every* branch — and `main` still reads it in roughly five places:

- `src/repositories/event_repository.ts`
- `src/agent/event_detection_agent.ts`
- `src/schemas/event_schemas.ts`
- `src/routers/events_router.ts` (create/update body schemas)
- `src/repositories/activity_repository.ts`

Those branches would fail at the Postgres level (`column "description" does not
exist`), the same way `admin-console` failed on `users.banned` on 2026-07-19.

Contrast with `admin-console`'s `0034`, which is **additive** (`ADD COLUMN`) —
other branches simply never select the new columns, so it was safe to apply
early. Additive migrations tolerate a shared DB; destructive ones do not.

## Merge `admin-console` first

`0034` is currently claimed twice: `0034_spooky_red_hulk` (admin-console) and
`0034_create_event_notes` (here). Whichever branch merges second must renumber.
The order is not arbitrary:

- `admin-console`'s `0034` is **already applied** to the dev DB. If it renumbers,
  its file changes, so its hash changes, so Drizzle re-runs SQL that already ran
  → `column "banned" already exists` → manual ledger repair.
- This branch's `0034`–`0036` are **not applied**. Renumbering here produces new
  hashes that apply cleanly, with no repair.

So: `admin-console` keeps `0034`, this branch renumbers to `0035`–`0037`.

## Sequence

```
1. git pull on local main                (it was 5 commits behind origin/main)
2. merge admin-console -> main
3. rebase this branch on main, then renumber:
     rm drizzle/0034_create_event_notes.sql drizzle/0035_backfill_event_notes.sql \
        drizzle/0036_drop_events_description.sql
     rm the matching drizzle/meta/00{34,35,36}_snapshot.json
     drop those three entries from drizzle/meta/_journal.json
     bunx drizzle-kit generate --name create_event_notes     (-> 0035)
     bunx drizzle-kit generate --custom --name backfill_event_notes  (-> 0036, re-add the INSERT)
     bunx drizzle-kit generate --name drop_events_description (-> 0037)
4. merge this branch -> main
5. EVERY other worktree pulls main        <-- before step 6, not after
6. bun run db:migrate                     (the drop lands here)
```

Step 5 before step 6 is the one that bites. In the window between the merge and a
given worktree pulling, that worktree runs pre-drop code against a post-drop
database.

Do **not** hand-rename the snapshot files when renumbering. Each
`NNNN_snapshot.json` encodes full schema state and chains to the previous one; a
snapshot built on the pre-main schema, renamed to sit after main's migration,
describes a schema that never existed and corrupts future `db:generate`.

The backfill (`0035` today) must stay sequenced *between* the create and the
drop — it copies `events.description` into the anchor `event_notes` row, so it is
worthless after the drop and impossible before the create.

## Verify

```
just migration-status          # from the workspace root; must report no collisions
```

It exits non-zero on an index collision or on orphan ledger rows. Run it after
renumbering and again after the merge.

## If the drop lands before a branch pulls

That branch is not damaged — its code is just ahead of what the DB now has. Pull
main into it. If you need it running before it can pull, give it its own
database instead of reverting anything:

```
docker exec interval_insights_db psql -U interval_userp -d postgres \
  -c 'CREATE DATABASE interval_insights_<branch> TEMPLATE interval_insights_dev'
```

then point that worktree's `.env` at the copy. `TEMPLATE` requires no active
connections to the source database.

## Background

- Workflow and repair procedures: the `db-migration` skill.
- Claims table: `knowledge/knowledge/agents/migration-claims.md` — mark this
  branch's rows `merged` once it lands, and never reuse a retired index.
- Canonical status for this effort stays in
  `knowledge/knowledge/projects/events-lifecycle-and-notes.md`; this file covers
  only the merge mechanics.
