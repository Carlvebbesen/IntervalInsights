// Guards against mock drift: every "../src/..." module that tests/setup.ts
// replaces via mock.module must export (at least) every runtime export of the
// real module. A mock missing one export (`easePace`, once) makes every module
// that imports the missing name throw "Export named 'X' not found" at load —
// which silently killed ~91 tests before this guard existed.
//
// The real module can't be imported here (the registry is mocked), so its
// export names are extracted from the source text with a deliberately simple,
// conservative regex set. Type-only exports are ignored — mocks only need to
// satisfy runtime imports.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const TESTS_DIR = import.meta.dir;
const setupSource = readFileSync(join(TESTS_DIR, "setup.ts"), "utf8");

const mockedSpecifiers = [
  ...setupSource.matchAll(/mock\.module\(\s*"(\.\.\/src\/[^"]+)"/g),
].map((m) => m[1]);

function realExportNames(source: string): string[] {
  const names = new Set<string>();

  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  // export { a, b as c } lists (single-line; skip `export type { ... }`).
  for (const m of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const entry of m[1].split(",")) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const parts = trimmed.split(/\s+as\s+/);
      names.add((parts[1] ?? parts[0]).trim());
    }
  }
  return [...names];
}

describe("tests/setup.ts mock factories export every runtime export of the real module", () => {
  it("found the mocked ../src modules", () => {
    expect(mockedSpecifiers.length).toBeGreaterThan(0);
  });

  for (const specifier of mockedSpecifiers) {
    it(specifier, async () => {
      const realSource = readFileSync(join(TESTS_DIR, specifier), "utf8");
      const expected = realExportNames(realSource);
      expect(expected.length).toBeGreaterThan(0);

      const mocked = (await import(specifier)) as Record<string, unknown>;
      const mockedNames = new Set(Object.keys(mocked));

      const missing = expected.filter((name) => !mockedNames.has(name));
      expect(
        missing,
        `mock for ${specifier} is missing runtime exports: ${missing.join(", ")}`,
      ).toEqual([]);
    });
  }
});
