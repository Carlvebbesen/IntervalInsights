import { describe, expect, it } from "bun:test";
import { resolveResumeTrainingType } from "../src/services/utils";

describe("resolveResumeTrainingType", () => {
  it("user-submitted type always wins", () => {
    expect(
      resolveResumeTrainingType("LONG_INTERVALS", "SHORT_INTERVALS", "EASY"),
    ).toBe("LONG_INTERVALS");
  });

  it("fresh draft beats a stale column on force re-analysis (user null)", () => {
    expect(resolveResumeTrainingType(null, "LONG_INTERVALS", "SHORT_INTERVALS")).toBe(
      "LONG_INTERVALS",
    );
  });

  it("uses the column only when user and draft are both null (legacy fallback)", () => {
    expect(resolveResumeTrainingType(null, null, "EASY")).toBe("EASY");
  });

  it("returns null when all three are null", () => {
    expect(resolveResumeTrainingType(null, null, null)).toBeNull();
  });
});
