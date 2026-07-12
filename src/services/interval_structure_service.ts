import type z from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { SIGNATURE_VENUES } from "../agent/running_venues";
import type { InsertIntervalSegment } from "../schema";

export type IntervalComponent = {
  value: number;
  unit: "m" | "km" | "sec" | "min";
};

export type VenueContext = {
  confirmedTokens: string[];
  hasGps: boolean;
};

const VENUE_SNAP_TOLERANCE = 0.025;
const DISTANCE_QUANTUM_SHORT = 50;
const DISTANCE_QUANTUM_LONG = 250;
const DISTANCE_LONG_THRESHOLD = 3000;
const TIME_QUANTUM = 15;

type CanonicalComponent =
  | { kind: "distance"; meters: number }
  | { kind: "time"; seconds: number }
  | { kind: "venue"; token: string; meters: number };

export const normalize = (val: number, unit: IntervalComponent["unit"]): number => {
  switch (unit) {
    case "km":
      return val * 1000;
    case "min":
      return val * 60;
    default:
      return val;
  }
};

const isDistanceUnit = (unit: IntervalComponent["unit"]) => unit === "m" || unit === "km";

const quantize = (value: number, quantum: number) => Math.round(value / quantum) * quantum;

const snapToVenue = (meters: number, venue: VenueContext | undefined) => {
  for (const v of SIGNATURE_VENUES) {
    const within = Math.abs(meters - v.meters) / v.meters <= VENUE_SNAP_TOLERANCE;
    if (!within) continue;
    if (venue?.confirmedTokens.includes(v.token)) return { token: v.token, meters: v.meters };
    if (venue?.hasGps) continue;
    if (Math.round(meters) % DISTANCE_QUANTUM_SHORT !== 0)
      return { token: v.token, meters: v.meters };
  }
  return null;
};

export const canonicalizeComponents = (
  components: IntervalComponent[],
  venue?: VenueContext,
): CanonicalComponent[] => {
  const out: CanonicalComponent[] = [];
  for (const c of components) {
    const value = normalize(c.value, c.unit);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (isDistanceUnit(c.unit)) {
      const snapped = snapToVenue(value, venue);
      if (snapped) {
        out.push({ kind: "venue", token: snapped.token, meters: snapped.meters });
      } else {
        const quantum =
          value >= DISTANCE_LONG_THRESHOLD ? DISTANCE_QUANTUM_LONG : DISTANCE_QUANTUM_SHORT;
        out.push({ kind: "distance", meters: quantize(value, quantum) });
      }
    } else {
      out.push({ kind: "time", seconds: quantize(value, TIME_QUANTUM) });
    }
  }
  return out;
};

const renderPart = (c: CanonicalComponent): string => {
  switch (c.kind) {
    case "venue":
      return c.token;
    case "distance":
      return `${c.meters}m`;
    case "time":
      return `${c.seconds}s`;
  }
};

const partSortKey = (c: CanonicalComponent): [number, number] => {
  if (c.kind === "time") return [1, c.seconds];
  return [0, c.meters];
};

const uniqueSortedParts = (canon: CanonicalComponent[]): string[] => {
  const sorted = [...canon].sort((a, b) => {
    const [ak, av] = partSortKey(a);
    const [bk, bv] = partSortKey(b);
    return ak - bk || av - bv;
  });
  return [...new Set(sorted.map(renderPart))];
};

export const generateIntervalSignature = (
  components: IntervalComponent[],
  venue?: VenueContext,
): string => uniqueSortedParts(canonicalizeComponents(components, venue)).join("-");

export const mapSetsToIntervalComponent = (
  sets: z.infer<typeof workoutSet>[],
): IntervalComponent[] => {
  return sets.flatMap((set) =>
    Array.from({ length: set.set_reps }).flatMap(() =>
      set.steps.flatMap((step) =>
        Array.from({ length: step.reps }, () => ({
          value: step.work_value,
          unit: (step.work_type === "DISTANCE" ? "m" : "sec") as IntervalComponent["unit"],
        })),
      ),
    ),
  );
};

export const mapSegmentsToComponents = (segments: InsertIntervalSegment[]): IntervalComponent[] => {
  return segments
    .filter((s) => s.type === "INTERVALS" && s.targetType !== "custom" && s.targetValue > 0)
    .map((seg) => ({
      value: seg.targetValue,
      unit: (seg.targetType === "distance" ? "m" : "sec") as IntervalComponent["unit"],
    }));
};

export const generateStructureName = (
  components: IntervalComponent[],
  venue?: VenueContext,
): string => {
  const parts = uniqueSortedParts(canonicalizeComponents(components, venue));
  if (parts.length === 0) return "Free Workout";
  if (parts.length === 1) return `(n)x ${parts[0]}`;
  return `Mixed (${parts.join("/")})`;
};
