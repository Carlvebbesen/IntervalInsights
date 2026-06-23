import type { InsertActivity } from "../schema";
import type { DetailedActivity, SummaryActivity } from "../types/strava/IDetailedActivity";

/**
 * Strava DTO → DB-row mappers. Moved out of the schema layer so schema files
 * stay limited to table/enum/relation definitions.
 */

export function getDbInsertActivity(
  data: DetailedActivity,
  userId: string,
  processHeartRate: boolean,
): InsertActivity {
  return {
    userId,
    stravaActivityId: data.id,
    title: data.name,
    description: data.description,
    sportType: data.sport_type || data.type,
    distance: data.distance,
    movingTime: data.moving_time,
    totalElevationGain: data.total_elevation_gain,
    averageHeartRate: processHeartRate ? data.average_heartrate : null,
    startDateLocal: new Date(data.start_date_local),
    hasHeartrate: processHeartRate ? data.has_heartrate : false,
    gearId: data.gear_id,
    indoor: data.trainer,
  };
}

export function getDbInsertFromSummary(
  data: SummaryActivity,
  userId: string,
  processHeartRate: boolean,
): InsertActivity {
  return {
    userId,
    stravaActivityId: data.id,
    title: data.name,
    sportType: data.sport_type || data.type,
    distance: data.distance,
    movingTime: data.moving_time,
    totalElevationGain: data.total_elevation_gain,
    averageHeartRate: processHeartRate ? data.average_heartrate : null,
    maxHeartRate: processHeartRate ? data.max_heartrate : null,
    startDateLocal: new Date(data.start_date_local),
    hasHeartrate: processHeartRate ? data.has_heartrate : false,
    gearId: data.gear_id,
    indoor: data.trainer,
  };
}
