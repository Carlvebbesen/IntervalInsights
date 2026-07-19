import { logger } from "../logger";
import { isPowerSport } from "../schema";
import type { IIntervalsPowerCurve } from "../types/intervals/IIntervalsActivity";
import { intervalsApiService } from "./intervals_api_service";
import { withIntervalsToken } from "./intervals_token_helper";
import { isReviewUser } from "./review_account";
import { getDemoCorpus } from "./review_demo/corpus_cache";

export type BestEffortWindow = "this_season" | "last_season" | "custom";

export interface BestEffortPoint {
  durationSecs: number;
  label: string;
  value: number;
}

export interface BestEffortCurve {
  type: string;
  window: BestEffortWindow;
  unit: "watts" | "value";
  points: BestEffortPoint[];
}

export type BestEffortResult =
  | { status: "not_linked"; data: null }
  | { status: "no_data"; data: null }
  | { status: "ok"; data: BestEffortCurve };

const DURATION_BUCKETS: { secs: number; label: string }[] = [
  { secs: 5, label: "5s" },
  { secs: 15, label: "15s" },
  { secs: 30, label: "30s" },
  { secs: 60, label: "1m" },
  { secs: 120, label: "2m" },
  { secs: 300, label: "5m" },
  { secs: 600, label: "10m" },
  { secs: 1200, label: "20m" },
  { secs: 1800, label: "30m" },
  { secs: 3600, label: "60m" },
  { secs: 5400, label: "90m" },
];

function buildCurvesParam(
  window: BestEffortWindow,
  oldest?: string,
  newest?: string,
): string[] | null {
  switch (window) {
    case "this_season":
      return ["s0"];
    case "last_season":
      return ["s1"];
    case "custom":
      return oldest && newest ? [`r.${oldest}.${newest}`] : null;
  }
}

export async function fetchBestEffortCurve(
  userId: string,
  opts: { type?: string; window?: BestEffortWindow; oldest?: string; newest?: string },
): Promise<BestEffortResult> {
  if (isReviewUser(userId)) return { status: "ok", data: getDemoCorpus().curve };
  const result = await withIntervalsToken(userId, (accessToken) =>
    fetchBestEffortCurveWithToken(accessToken, opts),
  );
  return result.status === "not_linked" ? { status: "not_linked", data: null } : result.data;
}

async function fetchBestEffortCurveWithToken(
  accessToken: string,
  opts: { type?: string; window?: BestEffortWindow; oldest?: string; newest?: string },
): Promise<BestEffortResult> {
  const type = opts.type ?? "Run";
  const window = opts.window ?? "this_season";
  const curves = buildCurvesParam(window, opts.oldest, opts.newest);
  if (!curves) return { status: "no_data", data: null };

  let response: IIntervalsPowerCurve[];
  try {
    response = await intervalsApiService.getPowerCurves(accessToken, curves, type);
  } catch (err) {
    logger.error({ err }, "Intervals.icu power-curve fetch failed");
    return { status: "no_data", data: null };
  }

  const curve = Array.isArray(response) ? response.find((c) => c?.secs?.length) : undefined;
  if (!curve) return { status: "no_data", data: null };

  const values = curve.values ?? curve.watts ?? [];
  const secToValue = new Map<number, number>();
  curve.secs.forEach((s, i) => {
    const v = values[i];
    if (typeof v === "number") secToValue.set(s, v);
  });

  const points: BestEffortPoint[] = [];
  for (const bucket of DURATION_BUCKETS) {
    const exact = secToValue.get(bucket.secs);
    if (typeof exact === "number") {
      points.push({ durationSecs: bucket.secs, label: bucket.label, value: exact });
    }
  }
  if (points.length === 0) return { status: "no_data", data: null };

  return {
    status: "ok",
    data: { type, window, unit: isPowerSport(type) ? "watts" : "value", points },
  };
}
