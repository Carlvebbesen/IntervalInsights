import { Hono } from "hono";
import { env } from "bun";
import { TStravaEnv } from "../../types/IRouters";

const stravaWebhookRouter = new Hono<TStravaEnv>();

stravaWebhookRouter.get("/subscribe", async (c) => {
  console.log("Setting up subscription...");
  const CALLBACK_URL = `${env.APP_BASE_URL}api/strava/event`;
  console.log(CALLBACK_URL);
  const formData = new FormData();
  formData.append("client_id", env.STRAVA_CLIENT_ID!);
  formData.append("client_secret", env.STRAVA_CLIENT_SECRET!);
  formData.append("callback_url", CALLBACK_URL);
  formData.append("verify_token", env.STRAVA_WEBHOOK_VERIFY_TOKEN!);

  const response = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
    method: "POST",
    body: formData,
  });

  const data = await response.json();
  
  if (response.ok) {
    console.log("Subscription request sent successfully:", data);
  } else {
    console.error("Subscription request failed:", data);
  }
  return c.json(data, response);
});

/**
 * View Subscription (GET)
 * Fetches the current webhook subscription details from Strava.
 */
stravaWebhookRouter.get("/subscription", async (c) => {
const url = new URL("https://www.strava.com/api/v3/push_subscriptions");
url.searchParams.append("client_id", env.STRAVA_CLIENT_ID!);
url.searchParams.append("client_secret", env.STRAVA_CLIENT_SECRET!);

const response = await fetch(url.toString(), {
  method: "GET",
});

const data = await response.json();
  return c.json(data, response.status as any);
});

/**
 * Delete Subscription (DELETE)
 * Deletes a specific subscription by its ID.
 * Usage: DELETE /strava/webhook/subscription/:id
 */
stravaWebhookRouter.delete("/subscription/:id", async (c) => {
  const id = c.req.param("id");
  const url = new URL(`https://www.strava.com/api/v3/push_subscriptions/${id}`);
  url.searchParams.append("client_id", env.STRAVA_CLIENT_ID!);
  url.searchParams.append("client_secret", env.STRAVA_CLIENT_SECRET!);

  const response = await fetch(url.toString(), {
    method: "DELETE",
  });

  if (response.status === 204) {
    return c.json({ message: "Subscription deleted successfully" }, 200);
  }

  const errorData = await response.json();
  return c.json(errorData, response.status as any);
});

export default stravaWebhookRouter;
