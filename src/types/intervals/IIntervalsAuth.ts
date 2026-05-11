export interface IIntervalsTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  athlete_id?: string;
  token_type?: string;
  scope?: string;
}
