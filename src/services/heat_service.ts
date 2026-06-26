import type { TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import { easePace } from "./pace_service";

// Heat-adjusted paces. The model is a hybrid: a dew-point-linear slope sets the
// magnitude (so it tracks how muggy it actually is, not just air temperature),
// anchored to marathon heat-impact research at the aerobic end, then tapered by
// training zone because heat barely affects short/fast efforts. A small solar
// term accounts for direct sun. All adjustments are in sec/km (slower = +).

export type HeatZone = "easy" | "threshold" | "interval" | "rep";

export interface WeatherInput {
  temperatureC: number;
  humidity: number; // relative humidity, %
  uvIndex?: number | null;
  cloudCover?: number | null; // 0..1
  apparentTemperatureC?: number | null;
}

const DEWPOINT_THRESHOLD_C = 15; // below this, heat is a non-factor
const HEAT_SLOPE_SEC_PER_KM_PER_C = 1.7; // ≈ Tinman dew-point rule, ≈ marathon research at the easy end
const MAX_SOLAR_SEC_PER_KM = 3;
const MAX_HEAT_LOAD_SEC_PER_KM = 25; // hard cap (readiness penalty caps at 15 — same spirit)
const MEANINGFUL_LOAD_SEC_PER_KM = 2;

// Aerobic efforts take the full hit; reps are almost unaffected.
const ZONE_FACTOR: Record<HeatZone, number> = {
  easy: 1.0,
  threshold: 0.65,
  interval: 0.4,
  rep: 0.25,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Magnus-Tetens approximation: derive dew point from temperature + RH.
export function magnusDewPoint(temperatureC: number, humidityPct: number): number {
  const rh = clamp(humidityPct, 1, 100) / 100;
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(rh) + (a * temperatureC) / (b + temperatureC);
  return (b * gamma) / (a - gamma);
}

function solarLoad(weather: WeatherInput): number {
  const uv = weather.uvIndex ?? 0;
  const cloud = clamp(weather.cloudCover ?? 0, 0, 1);
  return clamp((uv / 2) * (1 - cloud), 0, MAX_SOLAR_SEC_PER_KM);
}

// Pre-zone heat load in sec/km.
export function baseHeatLoadSecPerKm(weather: WeatherInput): number {
  const dewC = magnusDewPoint(weather.temperatureC, weather.humidity);
  const heatTerm = Math.max(0, dewC - DEWPOINT_THRESHOLD_C) * HEAT_SLOPE_SEC_PER_KM_PER_C;
  return Math.min(heatTerm + solarLoad(weather), MAX_HEAT_LOAD_SEC_PER_KM);
}

export interface HeatModel {
  dewPointC: number;
  hasSun: boolean;
  perZoneDeltaSecPerKm: Record<HeatZone, number>;
  advisory: string;
}

export function computeHeatModel(weather: WeatherInput): HeatModel {
  const dewC = magnusDewPoint(weather.temperatureC, weather.humidity);
  const baseLoad = baseHeatLoadSecPerKm(weather);
  const hasSun = solarLoad(weather) >= 0.5;

  const perZoneDeltaSecPerKm = {
    easy: Math.round(baseLoad * ZONE_FACTOR.easy),
    threshold: Math.round(baseLoad * ZONE_FACTOR.threshold),
    interval: Math.round(baseLoad * ZONE_FACTOR.interval),
    rep: Math.round(baseLoad * ZONE_FACTOR.rep),
  } satisfies Record<HeatZone, number>;

  let advisory = "";
  if (baseLoad >= MEANINGFUL_LOAD_SEC_PER_KM) {
    const sun = hasSun ? " with strong sun" : "";
    advisory = `It's warm out (dew point ${Math.round(dewC)}°C${sun}). Expect easy paces about ${perZoneDeltaSecPerKm.easy} s/km slower; interval and rep efforts are far less affected.`;
  }

  return { dewPointC: Math.round(dewC * 10) / 10, hasSun, perZoneDeltaSecPerKm, advisory };
}

// Race distance → heat sensitivity, on the same aerobic→anaerobic spectrum as
// the zone taper: a marathon (aerobic, long) takes the full hit, a 5k far less.
const RACE_FACTOR_ANCHORS: { distanceM: number; factor: number }[] = [
  { distanceM: 5000, factor: 0.4 },
  { distanceM: 10000, factor: 0.55 },
  { distanceM: 21097.5, factor: 0.8 },
  { distanceM: 42195, factor: 1.0 },
];

function raceDistanceFactor(distanceM: number): number {
  const a = RACE_FACTOR_ANCHORS;
  if (distanceM <= a[0].distanceM) return a[0].factor;
  if (distanceM >= a[a.length - 1].distanceM) return a[a.length - 1].factor;
  for (let i = 0; i < a.length - 1; i++) {
    const lo = a[i];
    const hi = a[i + 1];
    if (distanceM <= hi.distanceM) {
      const t = (distanceM - lo.distanceM) / (hi.distanceM - lo.distanceM);
      return lo.factor + t * (hi.factor - lo.factor);
    }
  }
  return a[a.length - 1].factor;
}

// Seconds added to a race of the given distance under the supplied weather.
export function heatRaceDeltaSec(weather: WeatherInput, distanceM: number): number {
  const penaltySecPerKm = baseHeatLoadSecPerKm(weather) * raceDistanceFactor(distanceM);
  return Math.round(penaltySecPerKm * (distanceM / 1000));
}

export function heatZoneForTrainingType(trainingType: TrainingType | null): HeatZone {
  switch (trainingType) {
    case "EASY":
    case "RECOVERY":
    case "LONG":
    case "PROGRESSIVE_LONG":
      return "easy";
    case "TEMPO":
      return "threshold";
    case "SPRINTS":
    case "HILL_SPRINTS":
      return "rep";
    default:
      // SHORT_INTERVALS / LONG_INTERVALS / FARTLEK / RACE / OTHER / null → quality default
      return "interval";
  }
}

export interface HeatAdjustmentResult {
  paces: ExpandedIntervalSet[];
  penaltySecPerKm: number;
  advisory: string;
}

// Apply a single zone's heat penalty across every step (uniform, like readiness).
export function applyHeatAdjustment(
  basePaces: ExpandedIntervalSet[],
  weather: WeatherInput,
  zone: HeatZone,
): HeatAdjustmentResult {
  const model = computeHeatModel(weather);
  const penalty = model.perZoneDeltaSecPerKm[zone];

  if (penalty <= 0) return { paces: basePaces, penaltySecPerKm: 0, advisory: "" };

  const paces = basePaces.map((set) => ({
    ...set,
    steps: set.steps.map((step) => ({
      ...step,
      target_pace: easePace(step.target_pace, penalty),
    })),
  }));

  const sun = model.hasSun ? " and sunny" : "";
  const advisory = `Because it's warm (dew point ${Math.round(model.dewPointC)}°C${sun}), I've eased today's target paces by about ${penalty} s/km.`;
  return { paces, penaltySecPerKm: penalty, advisory };
}
