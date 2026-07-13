import type { InsertIntervalSegment, SelectIntervalSegment } from "../schema/interval_segments";

const NULL_RECOVERY = {
  recoveryTargetType: null,
  recoveryTargetValue: null,
  recoveryEndTime: null,
  recoveryDistance: null,
  recoveryDuration: null,
  recoveryAvgHeartRate: null,
} as const;

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
      i++;
    } else {
      out.push({ ...seg, ...NULL_RECOVERY });
    }
  }
  return out.map((s, idx) => ({ ...s, segmentIndex: idx }));
}

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
