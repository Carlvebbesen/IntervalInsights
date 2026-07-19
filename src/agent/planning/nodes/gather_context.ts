import type { RunnableConfig } from "@langchain/core/runnables";
import { AppError } from "../../../error";
import { logger } from "../../../logger";
import * as dashboardRepo from "../../../repositories/dashboard_repository";
import * as raceEventRepo from "../../../repositories/race_event_repository";
import * as userRepo from "../../../repositories/user_repository";
import { findOrCreateUserSettings } from "../../../repositories/user_settings_repository";
import { RUNNING_SPORT_TYPES } from "../../../schema/enums";
import { fetchTrainingSummary } from "../../../services/intervals_wellness_service";
import type {
  AthleteContext,
  AthleteWeekSummary,
  PlanBuilderConfigurable,
  PlanBuilderState,
} from "../plan_builder_state";

type WeekRow = {
  weekStart: string;
  trainingType: string | null;
  sessions: number;
  totalDistance: string | number | null;
};

function foldWeeks(rows: WeekRow[]): AthleteWeekSummary[] {
  const byWeek = new Map<string, AthleteWeekSummary>();
  for (const row of rows) {
    const key = row.weekStart;
    let week = byWeek.get(key);
    if (!week) {
      week = { weekStart: key, totalDistanceMeters: 0, typeCounts: {} };
      byWeek.set(key, week);
    }
    week.totalDistanceMeters += Number(row.totalDistance ?? 0);
    const type = row.trainingType ?? "UNCLASSIFIED";
    week.typeCounts[type] = (week.typeCounts[type] ?? 0) + Number(row.sessions ?? 0);
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export async function gatherContext(
  state: PlanBuilderState,
  config: RunnableConfig,
): Promise<Partial<PlanBuilderState>> {
  const { db } = config.configurable as PlanBuilderConfigurable;
  const log = logger.child({ node: "gatherContext", userId: state.userId });

  const user = await userRepo.findById(db, state.userId);
  const settings = await findOrCreateUserSettings(db, state.userId);
  const maxHeartRate = settings?.maxHeartRate ?? user?.maxHeartRate ?? null;

  let race: AthleteContext["race"] = null;
  if (state.input.raceEventId != null) {
    const r = await raceEventRepo.findByIdForUser(db, state.userId, state.input.raceEventId);
    if (!r) throw new AppError(404, "Race event not found or unauthorized");
    race = {
      name: r.name,
      date: r.date,
      distanceMeters: r.distanceMeters,
      targetTimeSeconds: r.targetTimeSeconds,
      priority: r.priority,
    };
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 8 * 7);
  const rows = (await dashboardRepo.runWeeksWithTypeSince(
    db,
    state.userId,
    [...RUNNING_SPORT_TYPES],
    since,
  )) as WeekRow[];
  const recentWeeks = foldWeeks(rows);

  let fitness: AthleteContext["fitness"] = null;
  if (user?.intervalsAthleteId) {
    try {
      const summary = await fetchTrainingSummary(db, state.userId);
      if (summary.status === "ok") {
        const { ctl, atl, rampRate } = summary.data.fitness;
        fitness = { ctl, atl, tsb: ctl != null && atl != null ? ctl - atl : null, rampRate };
      }
    } catch (err) {
      log.warn({ err }, "fitness summary failed — degrading to null");
      fitness = null;
    }
  }

  return {
    athleteContext: {
      athleteName: user?.name ?? null,
      maxHeartRate,
      intervalsConnected: !!user?.intervalsAthleteId,
      race,
      recentWeeks,
      fitness,
    },
  };
}
