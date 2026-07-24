import { logger } from "../logger";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import {
  handleIntervalsScopeChange,
  linkOrCreateFromIntervalsActivity,
  refreshLinkedIntervalsActivity,
} from "./intervals_link_service";
import { progressService } from "./progress_service";

export async function processIntervalsWebhook(
  event: IIntervalsWebhookEvent,
  context: IGlobalBindings,
) {
  const log = logger.child({ fn: "processIntervalsWebhook", type: event.type });

  if (event.type === "TEST") {
    log.info(
      { athleteId: event.athlete_id, outcome: "ignored" },
      "Intervals.icu TEST acknowledged",
    );
    return;
  }

  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.intervalsAthleteId, event.athlete_id),
    columns: { id: true, lastSeenAt: true },
  });

  if (!user) {
    log.info(
      { athleteId: event.athlete_id, outcome: "ignored" },
      "No user found for Intervals.icu athlete",
    );
    return;
  }

  if (event.type === "APP_SCOPE_CHANGED") {
    const outcome = await handleIntervalsScopeChange(context, user);
    log.info({ athleteId: event.athlete_id, userId: user.id, outcome }, "APP_SCOPE_CHANGED");
    return;
  }

  const rawActivity = (event as { activity?: { id: string | number } }).activity;
  const intervalsActivityId = rawActivity ? String(rawActivity.id) : undefined;

  if (event.type === "ACTIVITY_DELETED") {
    log.info(
      { athleteId: event.athlete_id, intervalsActivityId, outcome: "ignored" },
      "Ignoring Intervals.icu ACTIVITY_DELETED",
    );
    return;
  }

  const isIngest = event.type === "ACTIVITY_UPLOADED" || event.type === "ACTIVITY_CREATED";
  const isAnalyzed = event.type === "ACTIVITY_ANALYZED";
  const isUpdated = event.type === "ACTIVITY_UPDATED";

  if (!isIngest && !isAnalyzed && !isUpdated) {
    log.info({ athleteId: event.athlete_id, outcome: "ignored" }, "Ignoring Intervals.icu event");
    return;
  }

  if (!intervalsActivityId) {
    log.info(
      { athleteId: event.athlete_id, outcome: "ignored" },
      "Activity event missing activity.id, skipping",
    );
    return;
  }

  if (isUpdated || isAnalyzed) {
    const existing = await context.db.query.activities.findFirst({
      where: (a, { and, eq }) =>
        and(eq(a.userId, user.id), eq(a.intervalsIcuId, intervalsActivityId)),
      columns: { id: true },
    });
    if (existing) {
      const refresh = await refreshLinkedIntervalsActivity(context, user, existing.id);
      log.info(
        {
          athleteId: event.athlete_id,
          intervalsActivityId,
          localActivityId: existing.id,
          outcome: isUpdated ? "updated" : "refreshed",
          refresh,
        },
        "intervals.icu activity refreshed",
      );
      return;
    }
  }

  const result = await linkOrCreateFromIntervalsActivity(context, user, intervalsActivityId);
  log.info(
    {
      athleteId: event.athlete_id,
      intervalsActivityId,
      localActivityId: result.localActivityId,
      outcome: result.outcome,
    },
    "intervals.icu activity ingested",
  );

  if (result.outcome === "created" && result.localActivityId) {
    const row = await context.db.query.activities.findFirst({
      where: (a, { eq }) => eq(a.id, result.localActivityId as number),
      columns: { title: true, startDateLocal: true, analysisStatus: true },
    });
    if (row) {
      await progressService.publish(user.id, {
        type: "progress",
        data: {
          id: result.localActivityId,
          kind: "intervals_ingest",
          phase: "received",
          analysisStatus: row.analysisStatus ?? "pending",
          title: row.title ?? undefined,
          startDateLocal: row.startDateLocal?.toISOString(),
        },
      });
    }
  }
}
