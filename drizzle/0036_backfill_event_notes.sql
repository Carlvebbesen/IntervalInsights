-- Custom SQL migration file, put your code below! --
-- Backfill: every existing event's `description` becomes its anchor note.
-- All labelled source='ai' (accepted mislabel for manually-created events, whose
-- descriptions were user-authored). anchor created_at = events.created_at so
-- insert-order stays sane. Runs AFTER 0035 (create) and BEFORE 0037 (drop column).
INSERT INTO "event_notes" ("event_id", "user_id", "note", "source", "occurred_at", "is_anchor", "created_at", "updated_at")
SELECT "id", "user_id", "description", 'ai', "start_time", true, "created_at", "updated_at"
FROM "events";
