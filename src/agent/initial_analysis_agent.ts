import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { isPowerSport, trainingTypeEnum } from "../schema";
import type { IntervalsIcuPrediction } from "../schema/activities";
import { normalizeActivityStreams, prepareDataForLLM } from "../services/utils";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import { buildLapEvidenceBlock } from "./lap_evidence";
import { gptMiniModel, invokeStructured } from "./model";
import { venuePromptBlock } from "./running_venues";
import { STRUCTURE_EXTRACTION_RULES } from "./structure_prompt_rules";
export type WorkoutAnalysisOutput = z.infer<typeof workoutAnalysisOutput>;

export const workoutStep = z.object({
  reps: z.number().describe("How many times this specific step is repeated within the set/series."),
  work_type: z.enum(["DISTANCE", "TIME"]),
  work_value: z.number().describe("The duration (seconds) or distance (meters)."),
  recovery_type: z.enum(["DISTANCE", "TIME"]).nullable().optional(),
  recovery_value: z
    .number()
    .nullable()
    .optional()
    .describe("Rest after each rep in this step (seconds or meters)."),
});

export const workoutSet = z.object({
  set_reps: z
    .number()
    .describe(
      "How many times the sequence of steps is repeated. Default to 1 if not a repeating series.",
    ),
  steps: z.array(workoutStep).describe("The individual work segments within this set."),
  set_recovery: z
    .number()
    .nullable()
    .optional()
    .describe(
      "The rest Period between sets, could be TIME or DISTANCE value, could be same as between reps",
    ),
});

export const workoutAnalysisOutput = z.object({
  classification_reasoning: z
    .string()
    .describe(
      "Reason BEFORE classifying. State the single WORK-REP unit: duration in seconds and/or distance in meters PER ONE REP (the leading number is the rep COUNT, never the duration). Then apply the hard gate: a rep >= 120s OR >= 800m is LONG_INTERVALS; a rep < 120s AND < 800m is SHORT_INTERVALS. Example: '6x6min = 6 reps of 360s each; 360 >= 120 -> LONG_INTERVALS'.",
    ),
  training_type: z
    .enum(trainingTypeEnum.enumValues)
    .describe("The classified type of training based on pace and heart rate patterns."),
  confidence_score: z
    .number()
    .min(0)
    .max(1)
    .describe("How certain the model is about this classification."),
  intervals_description: z
    .string()
    .nullable()
    .optional()
    .describe(
      "If intervals are detected, describe them (e.g. '6x800m @ 3:45 pace with 90s rest'). Omit for steady runs.",
    ),
  structure: z
    .array(workoutSet)
    .nullable()
    .optional()
    .describe(
      "A list of workout sets. 10x1000m is one set with one step. 3x(3km,2km,1km) is one set with three steps and 3 set_reps.",
    ),
});

const CLASSIFICATION_RULES = `
- **LONG**: Total distance is > 20 km (running) or equivalent endurance session in another sport. Pace is generally steady or easy.
- **EASY**: Steady aerobic effort, no structured intervals. Covers both true low-intensity recovery-pace work and standard daily Zone 2/3 sessions. Distance <= 20 km for running.
- **RECOVERY**: Cross-training (elliptical, cycling, etc.) used as active recovery, not containing intervals.
- **SHORT_INTERVALS**: Structured work/rest periods where each work interval is short — < 800m AND < 2 minutes duration (e.g. 10x400m, 8x60s).
- **LONG_INTERVALS**: Structured work/rest periods where each work interval is long — >= 800m OR >= 2 minutes duration (e.g. 6x6min, 5x1000m, 4x2000m). A time-based rep of 2 minutes or more is ALWAYS long intervals, regardless of distance.
- **HILL_SPRINTS**: Short intervals (< 300m) with significant elevation gain during the work period.
- **SPRINTS**: Very short duration (< 30s), maximum effort (Max Speed/Anaerobic).
- **FARTLEK**: "Speed play." A mix of various interval lengths/intensities with NO clear repeating structure (e.g., random surges). Do NOT select this just because pace is messy; requires distinct high-effort surges.
- **PROGRESSIVE_LONG**: Distance > 15km. Pace strictly increases (gets faster) from start to finish.
- **TEMPO**: Sustained high effort (Threshold pace) for a block of time (e.g., 20-40 mins).
- **RACE**: Sustained maximal effort for the distance.

### SHORT_INTERVALS vs LONG_INTERVALS — HARD GATE (apply literally, do not eyeball)
Compute the size of ONE work rep (NOT the whole session, NOT the number of reps):
- rep_duration >= 120s  OR  rep_distance >= 800m  ->  LONG_INTERVALS
- rep_duration <  120s  AND rep_distance <  800m  ->  SHORT_INTERVALS
The leading number in a title is the rep COUNT, never the duration. "6x6min" = 6 reps of 360s each; 360 >= 120 -> LONG_INTERVALS.

| Title | Per-rep | Type |
|---|---|---|
| 6x6min | 360s | LONG_INTERVALS |
| 5x1000m | 1000m | LONG_INTERVALS |
| 4x2000m | 2000m | LONG_INTERVALS |
| 8x2min | 120s | LONG_INTERVALS |
| 10x400m | 400m (~80s) | SHORT_INTERVALS |
| 20x45/15 | 45s | SHORT_INTERVALS |
| 15x90/30s | 90s | SHORT_INTERVALS |
`;

/**
 * Sport-aware framing (D7). Runs get the original pace-based prompt verbatim
 * (empty block). Rides/skis get a block telling the model their intervals are
 * power/HR/speed-based, not pace-based — the trainingType taxonomy is unchanged
 * and applies to all three sports.
 */
function sportContextBlock(type: string): string {
  if (!isPowerSport(type)) return "";
  return `
  ### SPORT CONTEXT — ${type}
  This is a **${type}** activity, NOT a run. Judge work vs. recovery by POWER, HEART RATE and SPEED — do NOT expect or reason about running pace (min/km), and ignore the "Pace" column if it looks implausible for this sport. The classification taxonomy (EASY, LONG, RECOVERY, the interval types, TEMPO, RACE, …) is IDENTICAL to running and applies unchanged; only the SIGNAL you read intervals from differs. Distance thresholds in the definitions below are calibrated for running — treat them as loose guidance for other sports and lean on effort structure instead.
`;
}

function formatIntervalsIcuBlock(prediction: IntervalsIcuPrediction | null | undefined): string {
  if (!prediction) return "";
  const intervals = Array.isArray(prediction.intervals) ? prediction.intervals : [];
  const rows = intervals
    .map((i, idx) => {
      const speedMs =
        i.average_speed != null
          ? i.average_speed
          : i.moving_time > 0
            ? i.distance / i.moving_time
            : null;
      const pace = speedMs != null ? `${speedMs.toFixed(2)} m/s` : "-";
      const hr = i.average_heartrate != null ? `${Math.round(i.average_heartrate)} bpm` : "-";
      const load = i.training_load != null ? `${i.training_load.toFixed(1)}` : "-";
      return `| ${idx + 1} | ${i.type} | ${i.distance}m | ${i.moving_time}s | ${pace} | ${hr} | ${load} |`;
    })
    .join("\n");
  const typeHint = prediction.trainingType
    ? `intervals.icu suggests training type: **${prediction.trainingType}**${prediction.subType ? ` (sub: ${prediction.subType})` : ""}.`
    : "";
  const tableBlock = rows
    ? `\n| # | Type | Distance | Time | Avg pace | Avg HR | Load |\n|---|------|----------|------|----------|--------|------|\n${rows}`
    : "";
  return `\n  ### INTERVALS.ICU PREDICTION (treat as a strong hint, not ground truth)\n  ${typeHint}${tableBlock}\n`;
}

/**
 * Deterministic guardrail: reconcile SHORT_INTERVALS vs LONG_INTERVALS against the
 * model's OWN extracted structure. gpt-4o-mini reliably parses the per-rep value
 * into `work_value` but occasionally flips the gate inequality (observed: "7x4min
 * = 240s each; 240 < 120 -> SHORT"). A rep >= 120 s OR >= 800 m makes it LONG;
 * all reps shorter make it SHORT. Only touches the two interval subtypes.
 */
/**
 * Deterministic guardrail: collapse the Cartesian rep-count blowup. When the
 * per-rep lap evidence lists N reps of slightly varying measured size, gpt-4o-mini
 * sometimes emits N steps that EACH carry reps:N (observed: "10x1000m" → 9 steps ×
 * reps 9 = 81; "Treadmill" → 14 × 14 = 196), inflating the rep count N→N². The
 * signature is unmistakable and effectively never legitimate for N ≥ 3: a set whose
 * steps are all the same work_type and all carry the SAME reps value R equal to the
 * step count. Collapse it to a single step of reps:R sized at the MEDIAN measured
 * value (median, not min/max, so a single under/over-measured rep can't flip the
 * SHORT/LONG gate). Runs before reconcileIntervalSubtype so the gate sees the fixed
 * structure. A genuine sequence ("3,2,1 km") has reps:1 per step and is untouched.
 */
export function reconcileSetsBlowup(
  sets: z.infer<typeof workoutSet>[],
): z.infer<typeof workoutSet>[] {
  if (sets.length === 0) return sets;
  let changed = false;
  const fixed = sets.map((set) => {
    const steps = set.steps;
    if (steps.length < 3) return set;
    const r = steps[0].reps;
    const isBlowup =
      r === steps.length && steps.every((s) => s.reps === r && s.work_type === steps[0].work_type);
    if (!isBlowup) return set;
    const values = [...steps.map((s) => s.work_value)].sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    changed = true;
    return {
      ...set,
      steps: [{ ...steps[0], reps: r, work_value: Math.round(median) }],
    };
  });
  return changed ? fixed : sets;
}

export function reconcileStructureBlowup(
  out: z.infer<typeof workoutAnalysisOutput>,
): z.infer<typeof workoutAnalysisOutput> {
  const structure = out.structure;
  if (!structure || structure.length === 0) return out;
  const fixed = reconcileSetsBlowup(structure);
  return fixed === structure ? out : { ...out, structure: fixed };
}

export function reconcileIntervalSubtype(
  out: z.infer<typeof workoutAnalysisOutput>,
): z.infer<typeof workoutAnalysisOutput> {
  if (out.training_type !== "SHORT_INTERVALS" && out.training_type !== "LONG_INTERVALS") return out;
  const structure = out.structure;
  if (!structure || structure.length === 0) return out;
  let sawRep = false;
  let hasLongRep = false;
  for (const set of structure) {
    for (const step of set.steps) {
      sawRep = true;
      if (step.work_type === "DISTANCE" ? step.work_value >= 800 : step.work_value >= 120) {
        hasLongRep = true;
      }
    }
  }
  if (!sawRep) return out;
  const correct = hasLongRep ? "LONG_INTERVALS" : "SHORT_INTERVALS";
  return correct === out.training_type ? out : { ...out, training_type: correct };
}

export async function invokeActivityAnalysisAgent(
  streams: StreamSet,
  title: string,
  description: string,
  totalElevationGain: number,
  type: string,
  intervalsIcuPrediction?: IntervalsIcuPrediction | null,
  laps: Lap[] = [],
  model: ChatOpenAI = gptMiniModel,
): Promise<WorkoutAnalysisOutput | null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ?? [],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data,
  );

  const summary = prepareDataForLLM(normalized, 30);
  const hasHr = summary.metadata.avgHeartRate !== null;
  const tableHeader = hasHr
    ? `| Time | Pace (min/km) | HR | Moving% |\n  |------|--------------|----|---------|`
    : `| Time | Pace (min/km) | Moving% |\n  |------|--------------|---------|`;
  const tableRows = summary.buckets
    .map((b) =>
      hasHr
        ? `| ${b.time} | ${b.pace} | ${b.avgHr ?? "-"} | ${b.isMoving} |`
        : `| ${b.time} | ${b.pace} | ${b.isMoving} |`,
    )
    .join("\n");
  const intervalsIcuBlock = formatIntervalsIcuBlock(intervalsIcuPrediction);
  const lapEvidenceBlock = buildLapEvidenceBlock(laps, streams?.time?.data ?? []);
  const prompt = `
  You are an expert ${isPowerSport(type) ? "endurance" : "running"} coach analyzing Strava activity data.
${sportContextBlock(type)}
  ### 1. PRIORITY & CONTEXT
  - **Title/Description Priority:** You must prioritize the user's Title and Description over raw data IF the user explicitly names the workout (e.g., "10x400m", "Tempo Run", "Long Run").
  - **Ignore Generics:** If the title is generic (e.g., "Morning Run", "Lunch Run", "Run"), ignore it and rely 100% on the data stats.
  - **Device Lap Evidence:** If a "DEVICE LAP EVIDENCE" block is present below, it is a deterministic work/rest split from the athlete's own lap markers (recoveries already removed by pace) and is the STRONGEST structural signal you have — stronger than the 30s-sampled table and stronger than a raw intervals.icu block (which often mislabels every lap WORK). When it shows a clean repeating work grid, classify as the matching interval type and take the per-rep size from it, even if the Title is ambiguous/non-English or the sampled table looks steady.
  - **Fartlek Warning:** Do not default to "Fartlek" just because the data is noisy. Fartlek requires distinct, intentional surges in pace that don't fit a fixed grid. If it's just a steady run with bad GPS data, classify as EASY.

  ### 2. CLASSIFICATION DEFINITIONS
  Use these strict definitions:
  ${CLASSIFICATION_RULES}

  ### 3. ACTIVITY DATA
  - **User Title:** "${title}"
  - **User Description:** "${description}"
  - Activity type: ${type}

  **Aggregated Stats:**
  - Duration: ${(summary.metadata.totalTime / 60).toFixed(1)} minutes
  - Total Distance: ${(summary.metadata.totalDistance / 1000).toFixed(2)} km
  ${summary.metadata.avgHeartRate !== null ? `- Avg HR: ${Math.round(summary.metadata.avgHeartRate)} bpm` : "- Heart-rate data not available for this user"}
  - Total Elevation gained: ${totalElevationGain}

  **Sampled Data (30s Windows):**
  ${tableHeader}
  ${tableRows}
${intervalsIcuBlock}${lapEvidenceBlock}
  ### 4. STRUCTURE EXTRACTION RULES (Hierarchical)
  You must populate the 'structure' array (an array of Sets) using these rules:

  ${STRUCTURE_EXTRACTION_RULES}

  ${venuePromptBlock()}

  ### 5. TASK
  First fill 'classification_reasoning': state the per-rep work duration (s) and/or distance (m) for ONE rep, then apply the SHORT vs LONG hard gate. Then classify the run and populate the structure according to the rules above.
`;
  const result = await invokeStructured(workoutAnalysisOutput, prompt, "analyze activity", model);
  return result ? reconcileIntervalSubtype(reconcileStructureBlowup(result)) : result;
}
