export type StravaObjectType = 'activity' | 'athlete';
export type StravaAspectType = 'create' | 'update' | 'delete';

export interface IStravaWebhookEvent {
  /** Always either "activity" or "athlete" */
  object_type: StravaObjectType;
  /** For activity events, the activity's ID. For athlete events, the athlete's ID. */
  object_id: number;
  /** Always "create", "update", or "delete" */
  aspect_type: StravaAspectType;
  /** The athlete's ID */
  owner_id: number;
  /** The push subscription ID receiving this event */
  subscription_id: number;
  /** The time that the event occurred (epoch seconds) */
  event_time: number;
  updates: {[key: string]: string|number | undefined};
}