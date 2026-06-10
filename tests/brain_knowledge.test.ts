import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBrainPage, searchBrainPages } from "../src/agent/training/brain_knowledge";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "brain");

const NORWEGIAN_PAGE = `---
title: The Norwegian Method
type: method
tags: [methodology, threshold, endurance]
status: active
created: 2026-06-04
updated: 2026-06-04
sources: ["[[src-bakken]]"]
related: ["[[double-threshold]]", "[[lactate-threshold]]"]
---

# The Norwegian Method

> Lactate-controlled, **threshold-dominant** training that clusters quality work.

## How it works

Train at the sweet spot using [[double-threshold]] days and [[lactate-testing]].
`;

const DOUBLE_THRESHOLD_PAGE = `---
title: Double Threshold
type: session
tags: [threshold, session]
status: active
related: []
---

# Double Threshold

> Two sub-threshold interval sessions on the same day, morning and afternoon.
`;

const INDEX_PAGE = `---
title: Index
type: glossary
tags: [meta]
status: active
---

# Brain Index

Master catalog of every page.

- [[norwegian-method]]
- [[double-threshold]]
`;

beforeAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(join(FIXTURE_DIR, "methods"), { recursive: true });
  await mkdir(join(FIXTURE_DIR, "sessions"), { recursive: true });
  await mkdir(join(FIXTURE_DIR, "_templates"), { recursive: true });
  await writeFile(join(FIXTURE_DIR, "methods", "norwegian-method.md"), NORWEGIAN_PAGE);
  await writeFile(join(FIXTURE_DIR, "sessions", "double-threshold.md"), DOUBLE_THRESHOLD_PAGE);
  await writeFile(join(FIXTURE_DIR, "index.md"), INDEX_PAGE);
  await writeFile(join(FIXTURE_DIR, "log.md"), "# Log\nignored");
  await writeFile(join(FIXTURE_DIR, "_templates", "method.md"), "# Template\nignored");
});

describe("searchBrainPages", () => {
  test("finds pages by title and tag terms, excluding log and templates", async () => {
    const { results, totalPages } = await searchBrainPages("norwegian threshold", FIXTURE_DIR);
    expect(totalPages).toBe(3);
    expect(results[0].slug).toBe("norwegian-method");
    expect(results[0].title).toBe("The Norwegian Method");
    expect(results[0].tags).toContain("methodology");
    expect(results[0].summary).toContain("threshold-dominant");
    expect(results.map((r) => r.slug)).toContain("double-threshold");
  });

  test("returns a hint when nothing matches", async () => {
    const { results, hint } = await searchBrainPages("quantum chromodynamics", FIXTURE_DIR);
    expect(results).toHaveLength(0);
    expect(hint).toContain("index");
  });
});

describe("readBrainPage", () => {
  test("returns the full page with resolved links", async () => {
    const result = await readBrainPage("norwegian-method", FIXTURE_DIR);
    expect(result.found).toBe(true);
    expect(result.page?.title).toBe("The Norwegian Method");
    expect(result.page?.related).toEqual(["double-threshold", "lactate-threshold"]);
    expect(result.page?.links).toContain("double-threshold");
    expect(result.page?.links).not.toContain("lactate-testing");
    expect(result.page?.content).toContain("## How it works");
  });

  test("suggests close slugs when the page is missing", async () => {
    const result = await readBrainPage("norwegian", FIXTURE_DIR);
    expect(result.found).toBe(false);
    expect(result.suggestions).toContain("norwegian-method");
  });
});
