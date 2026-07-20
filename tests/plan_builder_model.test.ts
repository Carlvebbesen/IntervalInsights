import { afterEach, describe, expect, it } from "bun:test";
import { getPlanBuilderModel, gptMiniModel, resolvePlanBuilderModelName } from "../src/agent/model";
import { config } from "../src/config";

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

describe("getPlanBuilderModel — PLAN_BUILDER_REASONING_EFFORT", () => {
  const original = config.PLAN_BUILDER_REASONING_EFFORT;

  afterEach(() => {
    config.PLAN_BUILDER_REASONING_EFFORT = original;
  });

  it("omits reasoning options when the env is unset (provider default)", () => {
    config.PLAN_BUILDER_REASONING_EFFORT = undefined;
    expect(getPlanBuilderModel().reasoning).toBeUndefined();
  });

  it("wires reasoning.effort when the env is set", () => {
    config.PLAN_BUILDER_REASONING_EFFORT = "low";
    expect(getPlanBuilderModel().reasoning).toEqual({ effort: "low" });
  });
});
