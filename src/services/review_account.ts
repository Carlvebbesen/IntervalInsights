import { config } from "../config";

// Placeholder `users.strava_id` for the store-review demo account — it satisfies
// the app's "is Strava linked" checks without a real Strava athlete behind it.
export const REVIEW_STRAVA_ID = "0";

export function isReviewAccountEmail(email: string): boolean {
  return (
    config.REVIEW_ACCOUNT_EMAIL !== undefined && email.toLowerCase() === config.REVIEW_ACCOUNT_EMAIL
  );
}

let reviewUserId: string | null = null;

export function setReviewUserId(id: string): void {
  reviewUserId = id;
}

export function isReviewUser(userId: string | undefined | null): boolean {
  return reviewUserId != null && userId === reviewUserId;
}
