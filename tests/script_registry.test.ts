import { describe, expect, it } from "bun:test";
import { discoverTrackedScripts, findRegistryDrift } from "../scripts/_discover";
import { ONCE_SCRIPTS } from "../scripts/_registry";

const script = (name: string, once: boolean) => ({ name, file: `${name}.ts`, once });

describe("script registry", () => {
  it("discovers the harness-wrapped scripts with their once flag", async () => {
    const tracked = await discoverTrackedScripts();
    const byName = new Map(tracked.map((t) => [t.name, t]));

    expect(byName.get("backfill_canonical_signatures")?.once).toBe(true);
    expect(byName.get("backfill_training_load")?.once).toBe(false);
    // pure-compute scripts never touch the harness
    expect(byName.has("grade_segments")).toBe(false);
  });

  it("names every script after its own file", async () => {
    for (const t of await discoverTrackedScripts()) {
      expect(t.file).toBe(`${t.name}.ts`);
    }
  });

  it("lists exactly the once:true scripts in _registry.ts", async () => {
    const discovered = (await discoverTrackedScripts()).filter((t) => t.once).map((t) => t.name);
    expect(discovered.sort()).toEqual([...ONCE_SCRIPTS].sort());
    expect(findRegistryDrift(await discoverTrackedScripts(), ONCE_SCRIPTS)).toEqual([]);
  });
});

describe("registry drift", () => {
  it("catches a once:true script the runner would silently never run", () => {
    const drift = findRegistryDrift([script("a", true), script("b", true)], ["a"]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("b (b.ts) is once:true but missing from _registry.ts");
  });

  it("catches a registered script that is no longer once:true", () => {
    const drift = findRegistryDrift([script("a", false)], ["a"]);
    expect(drift).toEqual(["a (a.ts) is once:false but listed in _registry.ts"]);
  });

  it("catches a registered name with no script behind it", () => {
    const drift = findRegistryDrift([script("a", true)], ["a", "deleted"]);
    expect(drift).toEqual(["deleted is listed in _registry.ts but no script registers that name"]);
  });
});
