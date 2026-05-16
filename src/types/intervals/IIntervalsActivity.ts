// Matches intervals.icu's Activity schema from /api/v1/docs. Only the fields
// we actually read are listed — the real payload has ~170 fields.
export interface IIntervalsActivity {
  id: string;
  name: string;
  description: string | null;
  type: string;
  sub_type: string | null;
  start_date: string;
  start_date_local: string;
  moving_time: number;
  elapsed_time: number | null;
  distance: number;
  total_elevation_gain: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  icu_average_watts: number | null;
  icu_weighted_avg_watts: number | null;
  calories: number | null;
  icu_training_load: number | null;
  icu_intensity: number | null;
  decoupling: number | null;
  polarization_index: number | null;
  icu_ftp: number | null;
  icu_ctl: number | null;
  icu_atl: number | null;
  device_name: string | null;
  source: string | null;
  external_id: string | null;
  strava_id: number | null;
  paired_event_id: number | null;
  route_id: number | null;
  trainer: boolean | null;
  tags: string[] | null;
  created: string | null;
}

// Matches intervals.icu's Interval schema from /api/v1/docs. Only the fields
// we actually consume are listed — the real payload is much larger.
export interface IIntervalsInterval {
  id: number;
  type: string;
  start_index: number;
  end_index: number;
  distance: number;
  moving_time: number;
  elapsed_time: number | null;
  average_watts: number | null;
  max_watts: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_speed: number | null;
  intensity: number | null;
  training_load: number | null;
  label: string | null;
}

export interface IIntervalsAthlete {
  id: string;
  name: string | null;
  email: string | null;
  weight: number | null;
  ftp: number | null;
  lthr: number | null;
  timezone: string | null;
}
