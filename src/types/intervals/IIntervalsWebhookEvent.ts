export type IntervalsActivityEventType =
  | "ACTIVITY_UPLOADED"
  | "ACTIVITY_UPDATED"
  | "ACTIVITY_ANALYZED"
  | "ACTIVITY_DELETED";

export type IntervalsWebhookEventType = IntervalsActivityEventType | "APP_SCOPE_CHANGED";

export interface IIntervalsActivityWebhookEvent {
  event: IntervalsActivityEventType;
  athlete_id: string;
  activity_id: string;
  secret: string;
}

export interface IIntervalsScopeChangeWebhookEvent {
  event: "APP_SCOPE_CHANGED";
  athlete_id: string;
  secret: string;
}

export type IIntervalsWebhookEvent =
  | IIntervalsActivityWebhookEvent
  | IIntervalsScopeChangeWebhookEvent;
