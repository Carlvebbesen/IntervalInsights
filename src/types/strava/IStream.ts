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

/**
 * Common properties for all stream types.
 */
export interface BaseStream {
  /** The number of data points in this stream */
  original_size?: number;
  /** The level of detail (sampling) in which this stream was returned */
  resolution?: "low" | "medium" | "high";
  /** The base series used in the case the stream was downsampled */
  series_type?: "distance" | "time";
}

/**
 * A pair of latitude and longitude coordinates.
 */
export type LatLng = [number, number];

// --- Specialized Stream Interfaces ---

export interface DistanceStream extends BaseStream {
  /** The sequence of distance values for this stream, in meters */
  data: number[];
}

export interface TimeStream extends BaseStream {
  /** The sequence of time values for this stream, in seconds */
  data: number[];
}

export interface LatLngStream extends BaseStream {
  /** The sequence of lat/long values for this stream */
  data: LatLng[];
}

export interface AltitudeStream extends BaseStream {
  /** The sequence of altitude values for this stream, in meters */
  data: number[];
}

export interface SmoothVelocityStream extends BaseStream {
  /** The sequence of velocity values for this stream, in meters per second */
  data: number[];
}

export interface HeartrateStream extends BaseStream {
  /** The sequence of heart rate values for this stream, in beats per minute */
  data: number[];
}

export interface CadenceStream extends BaseStream {
  /** The sequence of cadence values for this stream, in rotations per minute */
  data: number[];
}

export interface PowerStream extends BaseStream {
  /** The sequence of power values for this stream, in watts */
  data: number[];
}

export interface TemperatureStream extends BaseStream {
  /** The sequence of temperature values for this stream, in celsius degrees */
  data: number[];
}

export interface MovingStream extends BaseStream {
  /** The sequence of moving values for this stream, as boolean values */
  data: boolean[];
}

export interface SmoothGradeStream extends BaseStream {
  /** The sequence of grade values for this stream, as percents of a grade */
  data: number[];
}

/**
 * A set of streams returned for an activity.
 */
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

// Define a concrete map of Key -> Interface
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