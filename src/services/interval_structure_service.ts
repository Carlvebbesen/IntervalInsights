import type z from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { SIGNATURE_VENUES } from "../agent/running_venues";
import type { InsertIntervalSegment } from "../schema";

/**
 * Interval-structure domain logic: signature generation and structure naming.
 * Moved out of the schema layer (which now holds only tables/enums/relations)
 * so the rules live with the rest of the business logic and can be reused by
 * services/controllers.
 *
 * Signatures are CANONICAL: raw work components are dropped (zero/custom),
 * snapped to a named venue when a measured distance lands on one, then
 * quantized, so measured GPS distances (1509 m) and clean prescriptions
 * (1500 m) that mean the same session collapse to one signature. See the
 * `signature-canonicalization` project note.
 */

export type IntervalComponent = {
  value: number;
  unit: "m" | "km" | "sec" | "min";
};

// Activity-level GPS confirmation, resolved upstream where streams are available
// (see resolveVenueContext). A two-way gate: a confirmed venue lets a distance
// snap even when the value looks like a clean prescription, while GPS present
// but unconfirmed vetoes a snap the athlete's location contradicts. GPS never
// forces a snap outside the venue's ±tolerance.
export type VenueContext = {
  // Venue tokens whose geofence the activity's GPS track confirmed.
  confirmedTokens: string[];
  // Whether a usable GPS track was available at all. When true, a venue NOT in
  // confirmedTokens is actively VETOED (the athlete was elsewhere, so a rep that
  // merely matches a venue length must not borrow its token). When false, there
  // is nothing to confirm or veto with, so snapping falls back to distance only.
  hasGps: boolean;
};

const VENUE_SNAP_TOLERANCE = 0.025;
const DISTANCE_QUANTUM_SHORT = 50; // < 3 km → nearest 50 m
const DISTANCE_QUANTUM_LONG = 250; // ≥ 3 km → nearest 250 m
const DISTANCE_LONG_THRESHOLD = 3000;
const TIME_QUANTUM = 15; // seconds

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

/** Snap a measured distance to a named venue, or null if none applies. */
const snapToVenue = (meters: number, venue: VenueContext | undefined) => {
  for (const v of SIGNATURE_VENUES) {
    const within = Math.abs(meters - v.meters) / v.meters <= VENUE_SNAP_TOLERANCE;
    if (!within) continue;
    // GPS is a two-way gate. Confirmed → snap outright (even a round value).
    if (venue?.confirmedTokens.includes(v.token)) return { token: v.token, meters: v.meters };
    // GPS present but this venue not confirmed → veto: the athlete was elsewhere
    // (e.g. a 1500 m track rep whose length happens to sit inside NG's window).
    if (venue?.hasGps) continue;
    // No GPS to judge with → distance-only heuristic: a non-round measured value
    // (1509 m) implies a real loop, not a clean prescription.
    if (Math.round(meters) % DISTANCE_QUANTUM_SHORT !== 0)
      return { token: v.token, meters: v.meters };
  }
  return null;
};

/**
 * Drop → snap → quantize. Produces the canonical component list a signature and
 * structure name are rendered from. Zero/negative values (custom/placeholder
 * segments) are dropped so they can't pollute the signature.
 */
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

// Sort key: distance-like parts (distances + venue tokens) first, ordered by
// metres; time parts after, ordered by seconds. Deterministic so equivalent
// workouts always render an identical signature.
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

type StructureStep = z.infer<typeof workoutSet>["steps"][number];

// A step's magnitude, times folded to whole minutes when divisible by 60.
const stepMagnitude = (step: StructureStep): { value: number; unit: "m" | "min" | "s" } => {
  if (step.work_type === "DISTANCE") return { value: step.work_value, unit: "m" };
  return step.work_value % 60 === 0
    ? { value: step.work_value / 60, unit: "min" }
    : { value: step.work_value, unit: "s" };
};

const formatStructureSet = (set: z.infer<typeof workoutSet>): string => {
  const steps = set.steps ?? [];
  if (steps.length === 0) return "";
  const setReps = set.set_reps > 0 ? set.set_reps : 1;

  if (steps.length === 1) {
    const step = steps[0];
    const count = setReps * (step.reps > 0 ? step.reps : 1);
    const { value, unit } = stepMagnitude(step);
    return count > 1 ? `${count}×${value}${unit}` : `${value}${unit}`;
  }

  // Multi-step: factor a shared unit ("3,2,1min") when every step has reps 1 and
  // the same unit; otherwise render each step in full ("3×400m,200m").
  const mags = steps.map(stepMagnitude);
  const uniform =
    steps.every((s) => (s.reps ?? 1) <= 1) && mags.every((m) => m.unit === mags[0].unit);
  if (uniform) {
    return `${setReps}×(${mags.map((m) => m.value).join(",")}${mags[0].unit})`;
  }
  const inner = steps
    .map((s, i) => {
      const { value, unit } = mags[i];
      const reps = s.reps > 0 ? s.reps : 1;
      return reps > 1 ? `${reps}×${value}${unit}` : `${value}${unit}`;
    })
    .join(",");
  return `${setReps}×(${inner})`;
};

/**
 * Compact human-readable summary of a draft workout structure for the pending
 * list badge — e.g. "10×1000m", "4×(3,2,1min)". Null when there is no structure.
 * Distances render in metres; times fold to whole minutes ("min") when divisible
 * by 60, else seconds ("s"). Multiple sets join with " | ".
 */
export const formatStructureSummary = (
  structure: z.infer<typeof workoutSet>[] | null | undefined,
): string | null => {
  if (!structure || structure.length === 0) return null;
  const parts = structure.map(formatStructureSet).filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(" | ") : null;
};
