import type { IIntervalsActivity } from "../../src/types/intervals/IIntervalsActivity";

/** A fully-populated synthetic intervals.icu activity for tests. */
export function synthIntervalsActivity(
  overrides: Partial<IIntervalsActivity> = {},
): IIntervalsActivity {
  return {
    id: `i-${Math.random().toString(36).slice(2)}`,
    name: "Intervals Run",
    description: null,
    type: "Run",
    sub_type: null,
    start_date: "2026-05-01T08:00:00",
    start_date_local: "2026-05-01T08:00:00",
    moving_time: 1800,
    elapsed_time: 1850,
    distance: 6000,
    total_elevation_gain: 40,
    average_heartrate: 150,
    max_heartrate: 175,
    icu_average_watts: null,
    icu_weighted_avg_watts: null,
    calories: 420,
    icu_training_load: 55,
    icu_intensity: 0.7,
    decoupling: null,
    polarization_index: null,
    icu_ftp: null,
    icu_ctl: 42,
    icu_atl: 50,
    device_name: "Garmin",
    source: null,
    external_id: null,
    strava_id: null,
    paired_event_id: null,
    route_id: null,
    trainer: false,
    tags: null,
    created: null,
    ...overrides,
  };
}
