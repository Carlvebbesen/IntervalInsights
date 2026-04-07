import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { sleep } from "bun";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { AnalysisStateAnnotation, type AnalysisState } from "./graph_state";
import { invokeActivityAnalysisAgent } from "./initial_analysis_agent";
import { invokeCompleteActivityAnalysisAgent } from "./full_analysis_agent";
import { stravaApiService } from "../services.ts/strava_api_service";
import {
  couldSkipCompleteAnalysis,
  needCompleteAnalysis,
  lapsMatchIntervals,
  calculateSegmentStats,
  parsePaceStringToMetersPerSecond,
} from "../services.ts/utils";
import {
  activities,
  intervalSegments,
  intervalStructures,
  generateIntervalSignature,
  generateStructureName,
  determineIntervalType,
  mapSegmentsToComponents,
} from "../schema";
import type * as schema from "../schema";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { TrainingType } from "../schema/enums";

type Db = NodePgDatabase<typeof schema>;
type Configurable = { db: Db; stravaAccessToken: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

async function invokeWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const msg = error?.message ?? "";
    const isRateLimit = error?.status === 429 || msg.includes("429");
    if (!isRateLimit) throw error;

    let waitMs = 10_000;
    const retryMatch = msg.match(/retry in ([\d.]+)s/);
    if (retryMatch?.[1]) {
      waitMs = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 2000;
    } else if (error?.retryDelay) {
      waitMs = parseInt(error.retryDelay) * 1000 + 2000;
    }
    console.warn(`Gemini quota exceeded. Waiting ${waitMs}ms before retry.`);
    await sleep(waitMs);
    return fn();
  }
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function classifyActivity(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken } = config.configurable as Configurable;

  const activity = await stravaApiService.getActivity(stravaAccessToken, state.stravaActivityId);
  const streams = await stravaApiService.getActivityStreams(
    stravaAccessToken,
    state.stravaActivityId,
    ["time", "velocity_smooth", "heartrate", "distance", "moving"],
  );

  if (!streams || Object.keys(streams).length === 0) {
    throw new Error(`No streams returned for activity ${state.stravaActivityId}`);
  }

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_init" })
    .where(eq(activities.id, state.activityId));

  let initialResult = await invokeWithRateLimitRetry(() =>
    invokeActivityAnalysisAgent(
      streams,
      activity.name,
      activity.description ?? "-",
      activity.total_elevation_gain,
      activity.type,
    ),
  );

  if (!initialResult) {
    throw new Error("Initial analysis agent returned null");
  }

  const canSkipComplete = couldSkipCompleteAnalysis(initialResult);
  const isIndoor = activity.trainer ?? false;

  let lapsMatchStructure = false;
  if (!canSkipComplete && needCompleteAnalysis(initialResult.training_type) && !isIndoor) {
    const laps = await stravaApiService.getActivityLaps(stravaAccessToken, state.stravaActivityId);
    lapsMatchStructure = lapsMatchIntervals(laps, initialResult);
  }

  await db
    .update(activities)
    .set({
      analyzedAt: new Date(),
      analysisStatus: "initial",
      draftAnalysisResult: initialResult,
      analysisVersion: "v2.0",
    })
    .where(eq(activities.id, state.activityId));

  return { initialResult, canSkipComplete, lapsMatchStructure, isIndoor };
}

async function markCompleted(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  await db
    .update(activities)
    .set({
      trainingType: state.initialResult!.training_type,
      analysisStatus: "completed",
    })
    .where(eq(activities.id, state.activityId));

  return {};
}

async function awaitUserInput(state: AnalysisState): Promise<Partial<AnalysisState>> {
  const userInput = interrupt({
    initialResult: state.initialResult,
    activityId: state.activityId,
  }) as { notes: string; sets: ExpandedIntervalSet[]; trainingType: string | null };

  return {
    userNotes: userInput.notes ?? "",
    userSets: userInput.sets ?? [],
    confirmedTrainingType: (userInput.trainingType as TrainingType | null) ?? null,
  };
}

async function runCompleteAnalysis(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken } = config.configurable as Configurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult!.training_type;

  // Types that don't need LLM segment breakdown — just mark completed with notes
  if (!needCompleteAnalysis(trainingType)) {
    await db
      .update(activities)
      .set({
        analysisStatus: "completed",
        notes: state.userNotes,
        trainingType,
      })
      .where(eq(activities.id, state.activityId));
    return { computedSegments: [] };
  }

  const streams = await stravaApiService.getActivityStreams(
    stravaAccessToken,
    state.stravaActivityId,
    ["time", "velocity_smooth", "heartrate", "distance", "moving"],
  );
  const laps = await stravaApiService.getActivityLaps(stravaAccessToken, state.stravaActivityId);

  if (!streams || Object.keys(streams).length === 0) {
    throw new Error(`No streams returned for activity ${state.stravaActivityId}`);
  }

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_completed" })
    .where(eq(activities.id, state.activityId));

  const segmentPlan = await invokeWithRateLimitRetry(() =>
    invokeCompleteActivityAnalysisAgent(
      streams,
      state.userNotes,
      trainingType,
      laps,
      state.initialResult,
      state.userSets,
    ),
  );

  if (!segmentPlan) {
    throw new Error("Complete analysis agent returned null");
  }

  let segmentIndexCounter = 0;
  const computedSegments = segmentPlan.segments
    .map((seg) => {
      const stats = calculateSegmentStats(streams, seg.start_time, seg.end_time);
      if (!stats) return null;
      return {
        activityId: state.activityId,
        segmentIndex: segmentIndexCounter++,
        setGroupIndex: seg.set_group_index ?? 0,
        type: seg.type,
        targetType: seg.target_type,
        targetValue: seg.target_value,
        targetPace: parsePaceStringToMetersPerSecond(seg.target_pace_string ?? ""),
        timeSeriesEndTime: stats.timeSeriesEndTime,
        actualDistance: stats.actualDistance,
        actualDuration: stats.actualDuration,
        actualPace: stats.actualPace,
        avgHeartRate: stats.avgHeartRate,
        maxHeartRate: stats.maxHeartRate,
        medianHeartRate: stats.medianHeartRate,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return { computedSegments };
}

async function validateSignature(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  const components = mapSegmentsToComponents(state.computedSegments);
  const signature = generateIntervalSignature(components);

  // Exact match first
  const exact = await db
    .select()
    .from(intervalStructures)
    .where(eq(intervalStructures.signature, signature))
    .limit(1);

  if (exact.length > 0) {
    return { signatureCheck: { useExisting: true, structureId: exact[0].id, signature } };
  }

  // Jaccard similarity against this user's existing structures
  const signatureParts = signature.split("-").sort();
  const candidates = await db
    .selectDistinct({ id: intervalStructures.id, signature: intervalStructures.signature })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .where(eq(activities.userId, state.userId));

  let bestId: number | undefined;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (!candidate.signature) continue;
    const candidateParts = candidate.signature.split("-").sort();
    const intersection = signatureParts.filter((p) => candidateParts.includes(p));
    const unionSize = new Set([...signatureParts, ...candidateParts]).size;
    const jaccard = intersection.length / unionSize;
    if (jaccard >= 0.7 && jaccard > bestScore) {
      bestScore = jaccard;
      bestId = candidate.id;
    }
  }

  if (bestId !== undefined) {
    return { signatureCheck: { useExisting: true, structureId: bestId, signature } };
  }

  return { signatureCheck: { useExisting: false, signature } };
}

async function persistResults(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as Configurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult!.training_type;
  const check = state.signatureCheck!;

  let structureId: number;
  if (check.useExisting && check.structureId !== undefined) {
    structureId = check.structureId;
  } else {
    const components = mapSegmentsToComponents(state.computedSegments);
    const [newStructure] = await db
      .insert(intervalStructures)
      .values({
        name: generateStructureName(components),
        signature: check.signature || null,
        trainingType,
        intervalType: determineIntervalType(state.computedSegments),
      })
      .returning();
    structureId = newStructure.id;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(activities)
      .set({
        intervalStructureId: structureId,
        trainingType,
        analysisStatus: "completed",
        analyzedAt: new Date(),
        notes: state.userNotes,
      })
      .where(eq(activities.id, state.activityId));

    await tx
      .delete(intervalSegments)
      .where(eq(intervalSegments.activityId, state.activityId));

    await tx.insert(intervalSegments).values(state.computedSegments);
  });

  return {};
}

// ── Routing ───────────────────────────────────────────────────────────────────

function routeAfterClassification(state: AnalysisState): "markCompleted" | "awaitUserInput" {
  if (state.canSkipComplete || state.lapsMatchStructure) {
    return "markCompleted";
  }
  return "awaitUserInput";
}

function routeAfterCompleteAnalysis(
  state: AnalysisState,
): "validateSignature" | typeof END {
  return state.computedSegments.length > 0 ? "validateSignature" : END;
}

// ── Checkpointer singleton ────────────────────────────────────────────────────

let _checkpointer: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!_checkpointer) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
    _checkpointer = new PostgresSaver(pool);
    await _checkpointer.setup();
  }
  return _checkpointer;
}

// ── Graph ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(AnalysisStateAnnotation)
  .addNode("classifyActivity", classifyActivity)
  .addNode("markCompleted", markCompleted)
  .addNode("awaitUserInput", awaitUserInput)
  .addNode("runCompleteAnalysis", runCompleteAnalysis)
  .addNode("validateSignature", validateSignature)
  .addNode("persistResults", persistResults)
  .addEdge(START, "classifyActivity")
  .addConditionalEdges("classifyActivity", routeAfterClassification, [
    "markCompleted",
    "awaitUserInput",
  ])
  .addEdge("markCompleted", END)
  .addEdge("awaitUserInput", "runCompleteAnalysis")
  .addConditionalEdges("runCompleteAnalysis", routeAfterCompleteAnalysis, [
    "validateSignature",
    END,
  ])
  .addEdge("validateSignature", "persistResults")
  .addEdge("persistResults", END);

let _compiledGraph: Awaited<ReturnType<typeof workflow.compile>> | null = null;

export async function buildAnalysisGraph() {
  if (!_compiledGraph) {
    const checkpointer = await getCheckpointer();
    _compiledGraph = workflow.compile({ checkpointer });
  }
  return _compiledGraph;
}

