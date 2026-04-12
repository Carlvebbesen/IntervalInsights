export type IntervalsWebhookEventType =
  | "ACTIVITY_CREATED"
  | "ACTIVITY_UPDATED"
  | "ACTIVITY_ANALYZED"
  | "ACTIVITY_DELETED";

export interface IIntervalsWebhookEvent {
  /** The type of event */
  event: IntervalsWebhookEventType;
  /** The Intervals.icu athlete ID */
  athlete_id: string;
  /** The Intervals.icu activity ID (e.g. "i12345") */
  activity_id: string;
  /** The shared secret for verification */
  secret: string;
}
