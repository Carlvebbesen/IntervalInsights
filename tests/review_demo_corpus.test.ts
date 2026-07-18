import { describe, expect, it } from "bun:test";
import { buildDemoCorpus } from "../src/services/review_demo/corpus";

const NOW = new Date("2026-07-01T12:00:00Z");

describe("buildDemoCorpus", () => {
  it("is deterministic for the same now", () => {
    expect(buildDemoCorpus(NOW)).toEqual(buildDemoCorpus(NOW));
  });

  it("produces unique demoKeys", () => {
    const corpus = buildDemoCorpus(NOW);
    const keys = corpus.activities.map((a) => a.demoKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(20);
  });

  it("generates non-flat heart-rate streams", () => {
    const corpus = buildDemoCorpus(NOW);
    const withHr = corpus.activities.find((a) => (a.streams.heartrate?.length ?? 0) > 10);
    expect(withHr).toBeDefined();
    const hr = withHr?.streams.heartrate as number[];
    const mean = hr.reduce((a, c) => a + c, 0) / hr.length;
    const variance = hr.reduce((a, c) => a + (c - mean) ** 2, 0) / hr.length;
    expect(variance).toBeGreaterThan(0);
  });

  it("computes a CTL series that spans the day range and stays finite/positive", () => {
    const corpus = buildDemoCorpus(NOW);
    const pts = corpus.fitnessSeries;
    expect(pts.length).toBeGreaterThan(0);

    const first = new Date(`${pts[0].date}T00:00:00Z`).getTime();
    const lastDate = new Date(`${pts[pts.length - 1].date}T00:00:00Z`).getTime();
    const spanDays = Math.round((lastDate - first) / 86_400_000) + 1;
    expect(pts.length).toBe(spanDays);

    for (const p of pts) {
      expect(Number.isFinite(p.ctl)).toBe(true);
      expect(p.ctl as number).toBeGreaterThan(0);
      expect(Number.isFinite(p.atl)).toBe(true);
    }
  });

  it("has at least one structured interval activity with segments and a matching structure", () => {
    const corpus = buildDemoCorpus(NOW);
    const structured = corpus.activities.find(
      (a) => a.segments.length > 0 && a.structureSignature != null,
    );
    expect(structured).toBeDefined();
    const sig = structured?.structureSignature;
    expect(corpus.structures.some((s) => s.signature === sig)).toBe(true);
  });

  it("provides two shoe gears with one near its replacement threshold", () => {
    const corpus = buildDemoCorpus(NOW);
    expect(corpus.gears.length).toBe(2);
    const near = corpus.gears.some((g) => g.baselineDistanceMeters! > 600_000);
    expect(near).toBe(true);
  });
});
