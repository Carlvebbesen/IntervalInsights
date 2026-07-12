export type StravaObjectType = "activity" | "athlete";
export type StravaAspectType = "create" | "update" | "delete";

export interface IStravaWebhookEvent {
  object_type: StravaObjectType;
  object_id: number;
  aspect_type: StravaAspectType;
  owner_id: number;
  subscription_id: number;
  event_time: number;
  updates: { [key: string]: string | number | undefined };
}
