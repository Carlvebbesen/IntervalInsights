// Phase-3 provider-read short-circuits for the store-review demo user: every
// provider-backed read serves the synthetic corpus without a token, while a
// normal token-less user still gets the exact not_linked/null behaviour.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { logger } from "../src/logger";
import { activities } from "../src/schema";
import {
  getLaps,
  getSplits,
  getStreams,
} from "../src/services/activity_source_service";
import { fetchFitnessSeries } from "../src/services/fitness_service";
import { getHeartRateAnalysis } from "../src/services/heart_rate_analysis_service";
import { fetchBestEffortCurve } from "../src/services/intervals_curve_service";
import { setReviewUserId } from "../src/services/review_account";
import { getDemoCorpus } from "../src/services/review_demo/corpus_cache";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

const corpus = getDemoCorpus();

let reviewUser: { id: string; clerkId: string };
let normalUser: { id: string; clerkId: string };

async function seedDemoActivity(userId: string, demoKey: string): Promise<number> {
  const demo = corpus.activities.find((a) => a.demoKey === demoKey);
  if (!demo) throw new Error(`no corpus activity ${demoKey}`);
  const db = getDb();
  const [row] = await db
    .insert(activities)
    .values({ ...demo.columns, userId })
    .returning({ id: activities.id });
  return row.id;
}

beforeAll(async () => {
  reviewUser = await createTestUser({
    role: "premium",
    processHeartRate: true,
    maxHeartRate: 190,
    strava: false,
    intervals: false,
  });
  normalUser = await createTestUser({
    role: "premium",
    processHeartRate: true,
    strava: false,
    intervals: false,
  });
  setReviewUserId(reviewUser.id);
});

afterAll(async () => {
  // Detach the review identity so it can't leak into other suites.
  setReviewUserId(randomUUID());
  await deleteTestUser(reviewUser.id);
  await deleteTestUser(normalUser.id);
  await closePool();
});

describe("streams/laps/splits short-circuit to the corpus", () => {
  it("serves corpus streams (HR included) for the review user without a token", async () => {
    const demoKey = corpus.activities[0].demoKey;
    const id = await seedDemoActivity(reviewUser.id, demoKey);
    const streams = await getStreams(getDb(), reviewUser.id, id);
    expect(streams).toEqual(corpus.activities[0].streams);
    expect(streams.heartrate?.length).toBeGreaterThan(0);
  });

  it("serves corpus laps and splits for the review user", async () => {
    // A distinct demoKey — intervals_icu_id is globally unique, so each corpus
    // activity may be seeded only once across the suite.
    const source = corpus.activities[1];
    expect(source.laps.length).toBeGreaterThan(0);
    const id = await seedDemoActivity(reviewUser.id, source.demoKey);
    const laps = await getLaps(getDb(), reviewUser.id, id);
    const splits = await getSplits(getDb(), reviewUser.id, id);
    expect(laps).toEqual(source.laps);
    expect(splits).toEqual(source.splits);
  });
});

describe("fitness series", () => {
  it("returns an ok series from the corpus for the review user", async () => {
    const result = await fetchFitnessSeries(getDb(), reviewUser.id, "2000-01-01", "2100-01-01");
    expect(result.status).toBe("ok");
    expect(result.data?.points.length).toBe(corpus.fitnessSeries.length);
  });

  // Post-P2: the calculated half is self-computed, so a token-less user with no
  // activities gets an empty computed series (no_data), not the old not_linked.
  it("returns no_data for a normal token-less user with no activities", async () => {
    const result = await fetchFitnessSeries(getDb(), normalUser.id, "2000-01-01", "2100-01-01");
    expect(result.status).toBe("no_data");
    expect(result.data).toBeNull();
  });
});

describe("best-effort curve (pace anchor source)", () => {
  it("returns an ok curve from the corpus for the review user", async () => {
    const result = await fetchBestEffortCurve(reviewUser.id, {});
    expect(result.status).toBe("ok");
    expect(result.data).toEqual(corpus.curve);
  });

  it("returns not_linked for a normal token-less user", async () => {
    const result = await fetchBestEffortCurve(normalUser.id, {});
    expect(result.status).toBe("not_linked");
  });
});

describe("heart-rate analysis", () => {
  it("returns ok with corpus zones for the review user (no token)", async () => {
    await seedDemoActivity(reviewUser.id, corpus.activities[2].demoKey);
    await seedDemoActivity(reviewUser.id, corpus.activities[3].demoKey);
    const result = await getHeartRateAnalysis(getDb(), reviewUser.id, {}, logger);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.zones).toEqual(corpus.hrZones);
      expect(result.points.length).toBeGreaterThan(0);
      expect(Object.keys(result.summaries).length).toBeGreaterThan(0);
    }
  });

  it("returns not_linked for a normal token-less user", async () => {
    const result = await getHeartRateAnalysis(getDb(), normalUser.id, {}, logger);
    expect(result.status).toBe("not_linked");
  });
});
