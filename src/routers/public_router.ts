import { Hono } from 'hono';
import { TPublicEnv } from '../types/IRouters';
import { env } from 'bun';
import { processStravaWebhook } from '../services.ts/process_strava_event';
import { IStravaWebhookEvent } from '../types/strava/IWebHookEvent';

const publicRouter = new Hono<TPublicEnv>();

publicRouter.get("/strava/event", (c) => {
  console.log("Strava handshake triggered");  
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return c.json({ "hub.challenge": challenge }, 200);
  }

  console.error("Verification failed: Token mismatch or invalid mode");
  return c.json({ error: "Verification failed" }, 403);
});

publicRouter.post("/strava/event", async (c) => {
  const body = (await c.req.json()) as IStravaWebhookEvent;

  console.log(`Strava event receivied: Type: ${body.aspect_type}, eventId: ${body.object_id} for athlete: ${body.owner_id}`);
  if (body.subscription_id?.toString() !== env.STRAVA_SUBSCRIPTION_ID) {
    return c.json({ status: "unauthorized" }, 401);
  }
  processStravaWebhook(body, c.env).catch(err => 
    console.error("Background processing failed:", err)
  );
  return c.json({ status: "ok" }, 200);
});

publicRouter.route("/", publicRouter);

export default publicRouter;