import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute, resolver } from "hono-openapi";
import { config } from "../config";
import { listInFlight } from "../repositories/activity_repository";
import type { AnalysisStatus } from "../schema/enums";
import {
  ActivityProgressSchema,
  ErrorSchema,
  ProgressDoneEventSchema,
  ProgressErrorEventSchema,
  ProgressEventSchema,
  ProgressSnapshotEventSchema,
  SyncProgressEventSchema,
} from "../schemas/api_schemas";
import {
  type ActivityProgress,
  progressService,
  type StreamHandle,
} from "../services/progress_service";
import type { TGlobalEnv } from "../types/IRouters";

const progressRouter = new Hono<TGlobalEnv>();

const IN_FLIGHT_STATUSES: readonly AnalysisStatus[] = [
  "pending",
  "ongoing_init",
  "initial",
  "ongoing_completed",
  "error",
];

const HEARTBEAT_MS = config.PROGRESS_HEARTBEAT_MS;

progressRouter.get(
  "/stream",
  describeRoute({
    description:
      "Per-user Server-Sent Events progress channel. On connect emits a `snapshot` of the user's in-flight activities, then streams `progress`, `done`, `sync`, `error`, and `ping` (heartbeat) events pushed by background tasks (ingestion/sync/analysis). Single long-lived GET; the app does not poll.",
    responses: {
      200: {
        description:
          "SSE stream. `event:` is the type; `data:` is the JSON payload. snapshot→ProgressSnapshotEvent, progress→ProgressEvent, done→ProgressDoneEvent, sync→SyncProgressEvent, error→ProgressErrorEvent, ping→{}.",
        content: {
          "text/event-stream": { schema: { type: "string" } },
          "application/json": {
            schema: resolver(
              ProgressSnapshotEventSchema.or(ProgressEventSchema)
                .or(ProgressDoneEventSchema)
                .or(SyncProgressEventSchema)
                .or(ProgressErrorEventSchema)
                .or(ActivityProgressSchema),
            ),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  (c) => {
    const db = c.env.db;
    const userId = c.get("userId");
    const log = c.var.logger;

    (c.env as { timeout?: (req: Request, seconds: number) => void }).timeout?.(c.req.raw, 0);

    return streamSSE(c, async (stream) => {
      const handle: StreamHandle = stream;
      const unregister = progressService.register(userId, handle);
      stream.onAbort(() => unregister());

      try {
        const rows = await listInFlight(db, userId, IN_FLIGHT_STATUSES);

        const inFlight: ActivityProgress[] = rows.map((r) => ({
          id: r.id,
          title: r.title,
          startDateLocal: r.startDateLocal.toISOString(),
          analysisStatus: r.analysisStatus ?? "pending",
          kind: "analysis",
        }));

        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ activities: inFlight }),
        });
      } catch (err) {
        log.error({ err }, "progress: failed to send initial snapshot");
      }

      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        if (stream.aborted) break;
        try {
          await stream.writeSSE({ event: "ping", data: "{}" });
        } catch (err) {
          log.warn({ err }, "progress: heartbeat write failed");
          break;
        }
      }

      unregister();
    });
  },
);

export default progressRouter;
