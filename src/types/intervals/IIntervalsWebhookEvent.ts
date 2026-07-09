export type IntervalsActivityEventType =
  | "ACTIVITY_UPLOADED"
  // The dashboard's "created" checkbox may deliver this instead of UPLOADED;
  // treated as an alias of UPLOADED by the handler.
  | "ACTIVITY_CREATED"
  | "ACTIVITY_UPDATED"
  | "ACTIVITY_ANALYZED"
  | "ACTIVITY_DELETED";

export type IntervalsWebhookEventType = IntervalsActivityEventType | "APP_SCOPE_CHANGED" | "TEST";

interface IIntervalsWebhookEventBase {
  athlete_id: string;
  timestamp?: string;
}

export interface IIntervalsActivityWebhookEvent extends IIntervalsWebhookEventBase {
  type: IntervalsActivityEventType;
  activity?: { id: string | number; [key: string]: unknown };
}

export interface IIntervalsScopeChangeWebhookEvent extends IIntervalsWebhookEventBase {
  type: "APP_SCOPE_CHANGED";
}

export interface IIntervalsTestWebhookEvent extends IIntervalsWebhookEventBase {
  type: "TEST";
}

export interface IIntervalsUnknownWebhookEvent extends IIntervalsWebhookEventBase {
  type: string;
  [key: string]: unknown;
}

export type IIntervalsWebhookEvent =
  | IIntervalsActivityWebhookEvent
  | IIntervalsScopeChangeWebhookEvent
  | IIntervalsTestWebhookEvent
  | IIntervalsUnknownWebhookEvent;

export interface IIntervalsWebhookPayload {
  secret: string;
  events: IIntervalsWebhookEvent[];
}
