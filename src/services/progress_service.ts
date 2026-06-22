import { logger } from "../logger";
import type { AnalysisStatus } from "../schema/enums";

export type ActivityProgress = {
  id: number;
  title: string;
  startDateLocal: string;
  analysisStatus: AnalysisStatus;
  kind: "analysis";
};

export type ProgressEvent =
  | { type: "snapshot"; data: { activities: ActivityProgress[] } }
  | {
      type: "progress";
      data: {
        id: number;
        kind: "strava_ingest" | "intervals_sync" | "analysis";
        phase: "received" | "processing" | "ready_for_review";
        analysisStatus?: AnalysisStatus;
        title?: string;
        startDateLocal?: string;
        message?: string;
      };
    }
  | {
      type: "done";
      data: { id: number; analysisStatus: "completed" | "initial" | "error"; title?: string };
    }
  | {
      type: "sync";
      data: {
        kind: "intervals_master_sync" | "strava_import" | "strava_master_sync";
        phase: "started" | "progress" | "completed";
        processed: number;
        total?: number;
        created?: number;
        linked?: number;
        updated?: number;
        descriptionsUpdated?: number;
        descriptionsRemaining?: number;
        failed?: number;
        message?: string;
      };
    }
  | { type: "error"; data: { id?: number; message: string } }
  | { type: "ping"; data: Record<string, never> };

export interface StreamHandle {
  writeSSE(message: { event: string; data: string }): Promise<void>;
}

export interface ProgressPublisher {
  register(userId: string, stream: StreamHandle): () => void;
  publish(userId: string, event: ProgressEvent): Promise<void>;
}

class InMemoryProgressPublisher implements ProgressPublisher {
  private readonly streams = new Map<string, Set<StreamHandle>>();

  register(userId: string, stream: StreamHandle): () => void {
    let set = this.streams.get(userId);
    if (!set) {
      set = new Set();
      this.streams.set(userId, set);
    }
    set.add(stream);
    return () => this.unregister(userId, stream);
  }

  private unregister(userId: string, stream: StreamHandle): void {
    const set = this.streams.get(userId);
    if (!set) return;
    set.delete(stream);
    if (set.size === 0) this.streams.delete(userId);
  }

  async publish(userId: string, event: ProgressEvent): Promise<void> {
    const set = this.streams.get(userId);
    if (!set || set.size === 0) return;
    const payload = { event: event.type, data: JSON.stringify(event.data) };
    await Promise.all(
      [...set].map(async (stream) => {
        try {
          await stream.writeSSE(payload);
        } catch (err) {
          logger.warn({ err, userId, eventType: event.type }, "progress: dropping dead stream");
          this.unregister(userId, stream);
        }
      }),
    );
  }
}

export const progressService: ProgressPublisher = new InMemoryProgressPublisher();
