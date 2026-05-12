import type { RunnableConfig } from "@langchain/core/runnables";
import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { getIntervalsAccessToken } from "../../middlewares/intervals_middleware";
import { activities, type IntervalsIcuPrediction } from "../../schema";
import { intervalsApiService } from "../../services.ts/intervals_api_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

const POLL_TICKS = 3;
const POLL_INTERVAL_MS = 15_000;

export async function maybeEnrichWithIntervalsIcu(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, clerkUserId, intervalsAthleteId } = config.configurable as GraphConfigurable;
  const tag = `[maybeEnrichWithIntervalsIcu activity=${state.activityId}]`;

  if (!intervalsAthleteId) {
    console.log(`${tag} user has not connected intervals.icu — skipping`);
    return {};
  }

  // intervals.icu's webhook fires only after its own analysis finishes and
  // commits both intervalsIcuId + intervalsAnalyzed together (see
  // intervals_link_service.commitLink). At the moment this node runs the link
  // is almost never present yet, so poll up to POLL_TICKS * POLL_INTERVAL_MS
  // before giving up.
  let intervalsIcuId: string | null = null;
  for (let i = 0; i <= POLL_TICKS; i++) {
    const row = await db.query.activities.findFirst({
      where: eq(activities.id, state.activityId),
      columns: { intervalsIcuId: true, intervalsAnalyzed: true },
    });
    if (row?.intervalsIcuId && row.intervalsAnalyzed) {
      intervalsIcuId = row.intervalsIcuId;
      break;
    }
    if (i === POLL_TICKS) break;
    console.log(`${tag} tick ${i + 1}/${POLL_TICKS} waiting for intervals.icu link`);
    await sleep(POLL_INTERVAL_MS);
  }

  if (!intervalsIcuId) {
    console.log(`${tag} no intervals.icu link after poll — proceeding without it`);
    return {};
  }

  try {
    const accessToken = await getIntervalsAccessToken(clerkUserId);
    const [intervalsMeta, intervals] = await Promise.all([
      intervalsApiService.getActivity(accessToken, intervalsIcuId),
      intervalsApiService.getActivityIntervals(accessToken, intervalsIcuId),
    ]);

    const prediction: IntervalsIcuPrediction = {
      subType: intervalsMeta.sub_type ?? null,
      intervals: intervals ?? [],
    };
    console.log(
      `${tag} attached intervals.icu prediction subType=${prediction.subType} intervals=${prediction.intervals?.length ?? 0}`,
    );
    return { intervalsIcuPrediction: prediction };
  } catch (error) {
    console.warn(`${tag} failed to fetch intervals.icu data — proceeding without it`, error);
    return {};
  }
}
