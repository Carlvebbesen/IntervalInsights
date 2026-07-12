import type { RunnableConfig } from "@langchain/core/runnables";
import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { getIntervalsAccessToken } from "../../middlewares/intervals_middleware";
import { activities, type IntervalsIcuPrediction } from "../../schema";
import { intervalsApiService } from "../../services/intervals_api_service";
import { linkFromLocalActivity } from "../../services/intervals_link_service";
import { extractIntervalsList } from "../../services/intervals_mappers";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

const POLL_TICKS = 3;
const POLL_INTERVAL_MS = 15_000;

export async function maybeEnrichWithIntervalsIcu(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, intervalsAthleteId } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "maybeEnrichWithIntervalsIcu", activityId: state.activityId });

  if (!intervalsAthleteId) {
    log.info("user has not connected intervals.icu — skipping");
    return {};
  }

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
    log.info({ tick: i + 1, of: POLL_TICKS }, "waiting for intervals.icu link");
    await sleep(POLL_INTERVAL_MS);
  }

  if (!intervalsIcuId) {
    try {
      const link = await linkFromLocalActivity({ db }, { id: state.userId }, state.activityId);
      if (link) {
        intervalsIcuId = link.intervalsActivityId;
        log.info({ intervalsIcuId }, "linked via GET-by-date fallback");
      }
    } catch (err) {
      log.warn({ err }, "intervals.icu GET-by-date fallback failed");
    }
  }

  if (!intervalsIcuId) {
    log.info("no intervals.icu link after poll — proceeding without it");
    return {};
  }

  try {
    const accessToken = await getIntervalsAccessToken(state.userId);
    const [intervalsMeta, intervalsRaw] = await Promise.all([
      intervalsApiService.getActivity(accessToken, intervalsIcuId),
      intervalsApiService.getActivityIntervals(accessToken, intervalsIcuId),
    ]);

    const intervals = extractIntervalsList(intervalsRaw);

    const prediction: IntervalsIcuPrediction = {
      subType: intervalsMeta.sub_type ?? null,
      intervals,
    };
    log.info(
      { subType: prediction.subType, intervals: prediction.intervals?.length ?? 0 },
      "attached intervals.icu prediction",
    );
    return { intervalsIcuPrediction: prediction };
  } catch (err) {
    log.warn({ err }, "failed to fetch intervals.icu data — proceeding without it");
    return {};
  }
}
