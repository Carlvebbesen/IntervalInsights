import { describe, expect, it } from "bun:test";
import { getPlanBuilderModel, gptMiniModel, resolvePlanBuilderModelName } from "../src/agent/model";

describe("resolvePlanBuilderModelName", () => {
  it("defaults to gpt-5 when nothing is configured", () => {
    expect(resolvePlanBuilderModelName(undefined)).toBe("gpt-5");
    expect(resolvePlanBuilderModelName(null)).toBe("gpt-5");
    expect(resolvePlanBuilderModelName("")).toBe("gpt-5");
  });

  it("uses the configured override (PLAN_BUILDER_MODEL) when present", () => {
    expect(resolvePlanBuilderModelName("gpt-5-mini")).toBe("gpt-5-mini");
    expect(resolvePlanBuilderModelName("  gpt-4o  ")).toBe("gpt-4o");
  });
});

describe("getPlanBuilderModel", () => {
  it("builds a model with the default name and no pinned temperature", () => {
    const model = getPlanBuilderModel();
    expect((model as unknown as { model?: string }).model).toBe("gpt-5");
    expect(model.temperature).toBeUndefined();
  });

  it("does not pin temperature the way the house mini model does", () => {
    // Sanity check the contrast: the house model deliberately pins temperature:0;
    // the planner factory deliberately must NOT (gpt-5-tier models reject it).
    expect(gptMiniModel.temperature).toBe(0);
    expect(getPlanBuilderModel().temperature).toBeUndefined();
  });
});
