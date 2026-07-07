import type { InsertIntervalSegment, SelectIntervalSegment } from "../schema/interval_segments";

/**
 * Option B storage: a normal `REST` segment is NOT stored as its own row — its
 * trailing recovery is FOLDED into the preceding `INTERVALS` (work) row's
 * `recovery_*` columns. `ACTIVE_REST`/`JOGGING`/`WARMUP`/`COOL_DOWN` stay their
 * own rows. `timeSeriesEndTime` stays end-of-work; the folded recovery occupies
 * `[timeSeriesEndTime, recoveryEndTime]`.
 *
 * Producers and the contiguous stats engine keep emitting EXPANDED segments
 * (work + REST rows); we fold only at the persistence boundary and expand only
 * on read, so the API/app contract, the signature, and the HR-stats windows are
 * unchanged.
 */

const NULL_RECOVERY = {
  recoveryTargetType: null,
  recoveryTargetValue: null,
  recoveryEndTime: null,
  recoveryDistance: null,
  recoveryDuration: null,
  recoveryAvgHeartRate: null,
} as const;

/** Collapse each normal `REST` row into the preceding `INTERVALS` row. Re-indexes. */
export function foldRestSegments(expanded: InsertIntervalSegment[]): InsertIntervalSegment[] {
  const out: InsertIntervalSegment[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const seg = expanded[i];
    const next = expanded[i + 1];
    if (seg.type === "INTERVALS" && next?.type === "REST") {
      out.push({
        ...seg,
        ...NULL_RECOVERY,
        recoveryTargetType: next.targetType,
        recoveryTargetValue: next.targetValue,
        recoveryEndTime: next.timeSeriesEndTime,
        recoveryDistance: next.actualDistance,
        recoveryDuration: next.actualDuration,
        recoveryAvgHeartRate: next.avgHeartRate ?? null,
      });
      i++; // consumed the folded REST
    } else {
      out.push({ ...seg, ...NULL_RECOVERY });
    }
  }
  return out.map((s, idx) => ({ ...s, segmentIndex: idx }));
}

/**
 * Reconstruct the expanded work + normal-`REST` list from folded stored rows, so
 * everything downstream (API, app, MCP, the editor) sees the same shape as before
 * Option B. Synthesised REST rows get negative ids (they have no DB identity).
 */
export function expandRestSegments(folded: SelectIntervalSegment[]): SelectIntervalSegment[] {
  const out: SelectIntervalSegment[] = [];
  let synthId = -1;
  for (const seg of folded) {
    if (seg.type === "INTERVALS" && seg.recoveryEndTime != null) {
      out.push({ ...seg, ...NULL_RECOVERY });
      out.push({
        ...seg,
        ...NULL_RECOVERY,
        id: synthId--,
        type: "REST",
        targetType: seg.recoveryTargetType ?? "custom",
        targetValue: seg.recoveryTargetValue ?? 0,
        targetPace: null,
        timeSeriesEndTime: seg.recoveryEndTime,
        actualDistance: seg.recoveryDistance ?? 0,
        // recoveryDuration is always set when recoveryEndTime is; fall back to
        // the timestamp span so a synthesised REST can never be zero-duration.
        actualDuration:
          seg.recoveryDuration ??
          Math.max(0, Math.round(seg.recoveryEndTime - seg.timeSeriesEndTime)),
        avgHeartRate: seg.recoveryAvgHeartRate ?? null,
      });
    } else {
      out.push(seg);
    }
  }
  return out.map((s, idx) => ({ ...s, segmentIndex: idx }));
}
