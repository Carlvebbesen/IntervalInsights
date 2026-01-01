export interface DetailedActivity extends SummaryActivity {
  description?: string;
  calories: number;
  segment_efforts: any[];
  splits_metric?: SplitMetrics[];
  laps: any[];
  gear?: Gear;
  device_name: string;
  embed_token: string;
}
export interface SummaryActivity {
  id: number;
  resource_state: number;
  external_id: string;
  upload_id: number;
  athlete: { id: number; resource_state: number };
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  type: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  timezone: string;
  utc_offset: number;
  start_latlng: [number, number];
  end_latlng: [number, number];
  location_city?: string;
  location_state?: string;
  location_country?: string;
  achievement_count: number;
  kudos_count: number;
  comment_count: number;
  athlete_count: number;
  average_temp?: number;
  photo_count: number;
  map: { id: string; summary_polyline: string; resource_state: number };
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  private: boolean;
  flagged: boolean;
  gear_id: string;
  average_speed: number;
  max_speed: number;
  has_heartrate: boolean;
  average_heartrate?: number;
  max_heartrate?: number;
  elev_high: number;
  elev_low: number;
  pr_count: number;
}
export interface MetaAthlete {
  id: number;
  resource_state: number;
}
export interface PolylineMap {
  id: string;
  polyline: string;
  summary_polyline: string;
  resource_state: number;
}
export interface SegmentEffort {
  id: number;
  resource_state: number;
  name: string;
  activity: { id: number; resource_state: number };
  athlete: MetaAthlete;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  start_date_local: string;
  distance: number;
  start_index: number;
  end_index: number;
  average_cadence: number;
  device_watts: boolean;
  average_watts: number;
  segment: Segment;
  kom_rank: number | null;
  pr_rank: number | null;
  achievements: any[];
  hidden: boolean;
}

export interface SplitMetrics {
  distance: number;
  elapsed_time: number;
  elevation_difference: number;
  moving_time: number;
  split: number;
  average_speed: number;
  average_grade_adjusted_speed: number;
  average_heartrate: number;
  pace_zone: number;
}
export interface Segment {
  id: number;
  resource_state: number;
  name: string;
  activity_type: string;
  distance: number;
  average_grade: number;
  maximum_grade: number;
  elevation_high: number;
  elevation_low: number;
  start_latlng: [number, number];
  end_latlng: [number, number];
  climb_category: number;
  city: string;
  state: string;
  country: string;
  private: boolean;
  hazardous: boolean;
  starred: boolean;
}
export interface Split {
  distance: number;
  elapsed_time: number;
  elevation_difference: number;
  moving_time: number;
  split: number;
  average_speed: number;
  pace_zone: number;
}
export interface Lap {
  id: number;
  resource_state: number;
  name: string;
  activity: { id: number; resource_state: number };
  athlete: MetaAthlete;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  start_date_local: string;
  distance: number;
  start_index: number;
  end_index: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_cadence: number;
  device_watts: boolean;
  average_watts: number;
  lap_index: number;
  split: number;
}
export interface Gear {
  id: string;
  primary: boolean;
  name: string;
  resource_state: number;
  distance: number;
}
export interface PhotosSummary {
  primary: {
    id: string | null;
    unique_id: string;
    urls: { [key: string]: string };
    source: number;
  };
  use_primary_photo: boolean;
  count: number;
}
export interface Kudosers {
  destination_url: string;
  display_name: string;
  avatar_url: string;
  show_name: boolean;
}
