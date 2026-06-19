import { describe, expect, it } from "bun:test";
import { progressService, type StreamHandle } from "../src/services/progress_service";

function recordingStream() {
  const frames: { event: string; data: string }[] = [];
  const handle: StreamHandle = {
    writeSSE: async (m) => {
      frames.push(m);
    },
  };
  return { frames, handle };
}

const uid = () => `u-${crypto.randomUUID()}`;

describe("progressService.publish", () => {
  it("delivers a published event to a registered stream as an SSE frame", async () => {
    const userId = uid();
    const s = recordingStream();
    const unregister = progressService.register(userId, s.handle);

    await progressService.publish(userId, {
      type: "progress",
      data: { id: 7, kind: "analysis", phase: "processing" },
    });

    expect(s.frames).toHaveLength(1);
    expect(s.frames[0].event).toBe("progress");
    expect(JSON.parse(s.frames[0].data)).toEqual({ id: 7, kind: "analysis", phase: "processing" });
    unregister();
  });

  it("fans a single event out to every stream the user has open", async () => {
    const userId = uid();
    const a = recordingStream();
    const b = recordingStream();
    progressService.register(userId, a.handle);
    progressService.register(userId, b.handle);

    await progressService.publish(userId, {
      type: "done",
      data: { id: 1, analysisStatus: "completed" },
    });

    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
    expect(a.frames[0].event).toBe("done");
    expect(b.frames[0].event).toBe("done");
  });

  it("stops delivering after the stream is unregistered", async () => {
    const userId = uid();
    const s = recordingStream();
    const unregister = progressService.register(userId, s.handle);
    unregister();

    await progressService.publish(userId, { type: "ping", data: {} });

    expect(s.frames).toHaveLength(0);
  });

  it("isolates a throwing stream and keeps delivering to its siblings", async () => {
    const userId = uid();
    const good = recordingStream();
    const dead: StreamHandle = {
      writeSSE: async () => {
        throw new Error("socket closed");
      },
    };
    progressService.register(userId, dead);
    progressService.register(userId, good.handle);

    await progressService.publish(userId, { type: "error", data: { message: "boom" } });
    expect(good.frames).toHaveLength(1);

    // the dead stream was dropped on the failed write — a second publish still
    // reaches the healthy sibling only
    await progressService.publish(userId, { type: "ping", data: {} });
    expect(good.frames).toHaveLength(2);
  });

  it("is a no-op when the user has no open streams", async () => {
    await expect(
      progressService.publish(uid(), { type: "ping", data: {} }),
    ).resolves.toBeUndefined();
  });

  it("scopes delivery to the addressed user only", async () => {
    const u1 = uid();
    const u2 = uid();
    const s1 = recordingStream();
    const s2 = recordingStream();
    progressService.register(u1, s1.handle);
    progressService.register(u2, s2.handle);

    await progressService.publish(u1, { type: "ping", data: {} });

    expect(s1.frames).toHaveLength(1);
    expect(s2.frames).toHaveLength(0);
  });
});
