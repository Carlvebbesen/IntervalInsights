export interface IIntervalsActivity {
  id: string;
  athlete_id: string;
  name: string;
  description: string | null;
  type: string;
  sub_type: string | null;
  start_time: string;
  local_start_time: string;
  moving_time: number;
  elapsed_time: number;
  distance: number;
  elevation_gain: number | null;
  average_hr: number | null;
  max_hr: number | null;
  average_power: number | null;
  weighted_average_power: number | null;
  calories: number | null;
  training_load: number | null;
  icu_training_load: number | null;
  icu_intensity: number | null;
  relative_intensity: number | null;
  device_name: string | null;
  source: string | null;
  external_id: string | null;
  strava_id: number | null;
  paired_event_id: number | null;
  route_id: number | null;
  indoor: boolean;
  manual: boolean;
  tags: string[] | null;
  created: string;
  updated: string;
}

export interface IIntervalsInterval {
  id: number;
  name: string | null;
  start_index: number;
  end_index: number;
  type: string;
  avg_power: number | null;
  max_power: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace: number | null;
  distance: number;
  moving_time: number;
  work_interval: boolean;
  intensity_factor: number | null;
  training_load: number | null;
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
