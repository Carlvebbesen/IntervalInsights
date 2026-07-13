export interface ActivityDataPoint {
  time: number;
  velocity: number;
  heartrate: number;
  distance: number;
  moving: boolean;
}

export type StreamType =
  | "time"
  | "distance"
  | "latlng"
  | "altitude"
  | "velocity_smooth"
  | "heartrate"
  | "cadence"
  | "watts"
  | "temp"
  | "moving"
  | "grade_smooth";

export interface BaseStream {
  original_size?: number;
  resolution?: "low" | "medium" | "high";
  series_type?: "distance" | "time";
}

export type LatLng = [number, number];

export interface DistanceStream extends BaseStream {
  data: number[];
}

export interface TimeStream extends BaseStream {
  data: number[];
}

export interface LatLngStream extends BaseStream {
  data: LatLng[];
}

export interface AltitudeStream extends BaseStream {
  data: number[];
}

export interface SmoothVelocityStream extends BaseStream {
  data: number[];
}

export interface HeartrateStream extends BaseStream {
  data: number[];
}

export interface CadenceStream extends BaseStream {
  data: number[];
}

export interface PowerStream extends BaseStream {
  data: number[];
}

export interface TemperatureStream extends BaseStream {
  data: number[];
}

export interface MovingStream extends BaseStream {
  data: boolean[];
}

export interface SmoothGradeStream extends BaseStream {
  data: number[];
}

export interface StreamSet {
  time?: TimeStream;
  distance?: DistanceStream;
  latlng?: LatLngStream;
  altitude?: AltitudeStream;
  velocity_smooth?: SmoothVelocityStream;
  heartrate?: HeartrateStream;
  cadence?: CadenceStream;
  watts?: PowerStream;
  temp?: TemperatureStream;
  moving?: MovingStream;
  grade_smooth?: SmoothGradeStream;
}

export type StreamTypeMap = {
  time: TimeStream;
  distance: DistanceStream;
  latlng: LatLngStream;
  altitude: AltitudeStream;
  velocity_smooth: SmoothVelocityStream;
  heartrate: HeartrateStream;
  cadence: CadenceStream;
  watts: PowerStream;
  temp: TemperatureStream;
  moving: MovingStream;
  grade_smooth: SmoothGradeStream;
};
