import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as parseAgent from "../src/agent/parse_intervals_agent";
import { extractDeclaredStructure, looksStructured } from "../src/services/text_intent_service";

// looksStructured is the deterministic prefilter that decides whether text COULD
// declare a workout structure — the hard bar is that every generic title costs
// zero LLM calls while every structured declaration (incl. Norwegian) passes.
const STRUCTURED = [
  "10x1000m",
  "10 x 1000m",
  "6x6min",
  "20x45/15",
  "15x90/30s",
  "4x1000 etterfulgt av 20x45/15",
  "5 x (3,2,1 min)",
  "2 x 3,2,2 km",
  "3,2,1 km",
  "8x60s",
  "4x2000m",
  "did 8 of 10",
  "8 av 10",
  "10x400m + 4x200m",
  "12x200m",
  "3km followed by 2km",
];

const GENERIC: (string | null | undefined)[] = [
  "Morning Run",
  "Lunch Run",
  "Run",
  "Easy run",
  "Løpetur",
  "Rolig langtur",
  "Afternoon Run 🌞",
  "Intervals",
  "Marathon training week 12",
  "",
  "   ",
  null,
  undefined,
];

describe("looksStructured", () => {
  for (const text of STRUCTURED) {
    it(`returns true for structured "${text}"`, () => {
      expect(looksStructured(text)).toBe(true);
    });
  }
  for (const text of GENERIC) {
    it(`returns false for generic ${JSON.stringify(text)}`, () => {
      expect(looksStructured(text)).toBe(false);
    });
  }
});

describe("extractDeclaredStructure", () => {
  let spy: Mock<typeof parseAgent.invokeParseIntervalsAgent> | undefined;
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  it("makes zero agent calls when no text looks structured", async () => {
    spy = spyOn(parseAgent, "invokeParseIntervalsAgent");
    const out = await extractDeclaredStructure(["Morning Run", "Run", null], null);
    expect(out).toBeNull();
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("returns null when the parse agent yields empty sets", async () => {
    spy = spyOn(parseAgent, "invokeParseIntervalsAgent").mockResolvedValue({ sets: [] });
    const out = await extractDeclaredStructure(["10x1000m"], "LONG_INTERVALS");
    expect(out).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("passes the parsed sets through when non-empty", async () => {
    const sets = [{ set_reps: 1, steps: [{ reps: 10, work_type: "DISTANCE" as const, work_value: 1000 }] }];
    spy = spyOn(parseAgent, "invokeParseIntervalsAgent").mockResolvedValue({ sets });
    const out = await extractDeclaredStructure(["Morning Run", "10x1000m"], null);
    expect(out).toEqual(sets);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns null (never throws) when the parse agent errors", async () => {
    spy = spyOn(parseAgent, "invokeParseIntervalsAgent").mockRejectedValue(new Error("boom"));
    const out = await extractDeclaredStructure(["10x1000m"], null);
    expect(out).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
