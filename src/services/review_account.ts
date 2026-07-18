import { config } from "../config";

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
