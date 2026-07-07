import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { progressService } from "../src/services/progress_service";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };
let activityId: number;

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
  const seeded = await insertActivity(user.id, {
    title: "Streaming Run",
    analysisStatus: "pending",
    startDateLocal: new Date("2026-05-05T07:00:00Z"),
  });
  activityId = seeded.id;
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

/** Reads SSE frames from a byte-stream reader, skipping heartbeat pings. */
function frameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";

  async function readOne(timeoutMs: number): Promise<{ event: string; data: string }> {
    while (true) {
      const sep = buffer.indexOf("\n\n");
      if (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
        }
        return { event, data: dataLines.join("\n") };
      }
      const chunk = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs);
        reader.read().then(
          (r) => {
            clearTimeout(t);
            resolve(r);
          },
          (e) => {
            clearTimeout(t);
            reject(e);
          },
        );
      });
      if (chunk.done) throw new Error("stream ended before a full frame");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return async function next(timeoutMs = 5000) {
    while (true) {
      const frame = await readOne(timeoutMs);
      if (frame.event === "ping") continue;
      return frame;
    }
  };
}

describe("GET /api/progress/stream", () => {
  it("sends a snapshot of in-flight activities on connect, then pushes live events", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/progress/stream"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      if (!res.body) throw new Error("expected a streaming body");

      const reader = res.body.getReader();
      const next = frameReader(reader);

      // 1) snapshot on connect
      const snapshot = await next();
      expect(snapshot.event).toBe("snapshot");
      const snap = JSON.parse(snapshot.data) as {
        activities: Array<{ id: number; startDateLocal: string; analysisStatus: string }>;
      };
      const mine = snap.activities.find((a) => a.id === activityId);
      expect(mine).toBeDefined();
      expect(typeof mine?.startDateLocal).toBe("string");
      expect(mine?.analysisStatus).toBe("pending");

      // 2) a background task publishing now reaches this already-open stream
      await progressService.publish(user.id, {
        type: "done",
        data: { id: activityId, analysisStatus: "completed" },
      });

      const live = await next();
      expect(live.event).toBe("done");
      expect(JSON.parse(live.data)).toEqual({ id: activityId, analysisStatus: "completed" });

      await reader.cancel();
    }));
});
