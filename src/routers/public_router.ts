import { env } from "bun";
import { Hono } from "hono";
import { processStravaWebhook } from "../services.ts/process_strava_event";
import { processIntervalsWebhook } from "../services.ts/process_intervals_event";
import type { TPublicEnv } from "../types/IRouters";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";

const publicRouter = new Hono<TPublicEnv>();

publicRouter.get("/strava/event", (c) => {
	console.log("Strava handshake triggered");
	const mode = c.req.query("hub.mode");
	const token = c.req.query("hub.verify_token");
	const challenge = c.req.query("hub.challenge");
	const expectedToken = env.STRAVA_WEBHOOK_VERIFY_TOKEN;
	console.log(
		`Handshake - mode: ${mode}, token match: ${token === expectedToken}, challenge: ${challenge}`,
	);
	if (mode === "subscribe" && token === expectedToken) {
		return c.json({ "hub.challenge": challenge }, 200);
	}
	console.error("Verification failed: Token mismatch or invalid mode");
	return c.json({ error: "Verification failed" }, 403);
});
publicRouter.get("/health", (c) => {
	console.log("Health triggered");
	return c.json("i'm alive :D ", 200);
});
publicRouter.post("/strava/event", async (c) => {
	const body = (await c.req.json()) as IStravaWebhookEvent;

	console.log(
		`Strava event receivied: Type: ${body.aspect_type}, eventId: ${body.object_id} for athlete: ${body.owner_id}`,
	);
	if (body.subscription_id?.toString() !== env.STRAVA_SUBSCRIPTION_ID) {
		return c.json({ status: "unauthorized" }, 401);
	}
	processStravaWebhook(body, c.env).catch((err) =>
		console.error("Background processing failed:", err),
	);
	return c.json({ status: "ok" }, 200);
});

publicRouter.post("/intervals/event", async (c) => {
	const body = (await c.req.json()) as IIntervalsWebhookEvent;

	console.log(
		`Intervals.icu event received: ${body.event} for athlete: ${body.athlete_id}, activity: ${body.activity_id}`,
	);

	if (body.secret !== env.INTERVALS_WEBHOOK_SECRET) {
		return c.json({ status: "unauthorized" }, 401);
	}

	processIntervalsWebhook(body, c.env).catch((err) =>
		console.error("Intervals.icu webhook processing failed:", err),
	);
	return c.json({ status: "ok" }, 200);
});

publicRouter.route("/", publicRouter);

export default publicRouter;
