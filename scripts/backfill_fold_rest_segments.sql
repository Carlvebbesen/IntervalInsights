-- Option B backfill: fold each existing normal REST row into the INTERVALS row
-- IMMEDIATELY preceding it (matching foldRestSegments in code), then delete the
-- folded REST rows. ACTIVE_REST/JOGGING/WARMUP/COOL_DOWN and orphan RESTs (whose
-- immediate predecessor is not INTERVALS) are left untouched. Run with db:migrate.
UPDATE "interval_segments" w SET
  "recovery_target_type" = r."target_type",
  "recovery_target_value" = r."target_value",
  "recovery_end_time" = r."time_series_index_end",
  "recovery_distance" = r."actual_distance",
  "recovery_duration" = r."actual_duration",
  "recovery_avg_heart_rate" = r."avg_heart_rate"
FROM "interval_segments" r
WHERE r."type" = 'REST'
  AND w."type" = 'INTERVALS'
  AND w."activity_id" = r."activity_id"
  AND w."segment_index" = (
    SELECT MAX(s."segment_index") FROM "interval_segments" s
    WHERE s."activity_id" = r."activity_id" AND s."segment_index" < r."segment_index"
  );
--> statement-breakpoint
DELETE FROM "interval_segments" r
WHERE r."type" = 'REST'
  AND (
    SELECT s."type" FROM "interval_segments" s
    WHERE s."activity_id" = r."activity_id" AND s."segment_index" < r."segment_index"
    ORDER BY s."segment_index" DESC LIMIT 1
  ) = 'INTERVALS';
