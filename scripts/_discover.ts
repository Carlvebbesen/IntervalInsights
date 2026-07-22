import { readdir } from "node:fs/promises";

export interface TrackedScript {
  name: string;
  file: string;
  once: boolean;
}

const SCRIPTS_DIR = new URL(".", import.meta.url);

// The runners themselves: they name other scripts, so a naive source scan would
// mistake their own text for a registration.
const NOT_SCRIPTS = new Set(["status.ts", "run_pending.ts"]);

const MARKER = "runScript(";

/**
 * Every script whose body is wrapped by the harness — i.e. every script whose runs
 * land in `script_runs`. Derived from the source instead of a hand-kept list, so a
 * new script cannot be invisible to `scripts:status` the way an unregistered one is
 * invisible to `scripts:run`.
 */
export async function discoverTrackedScripts(dir: URL = SCRIPTS_DIR): Promise<TrackedScript[]> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !NOT_SCRIPTS.has(f))
    .sort();

  const found: TrackedScript[] = [];
  for (const file of files) {
    const src = await Bun.file(new URL(file, dir)).text();
    const at = src.indexOf(MARKER);
    if (at === -1) continue;
    const tail = src.slice(at);
    const name = /name:\s*"([^"]+)"/.exec(tail)?.[1];
    if (!name) continue;
    found.push({ name, file, once: /once:\s*(true|false)/.exec(tail)?.[1] === "true" });
  }
  return found;
}

/**
 * The registry drives `scripts:run`; the source drives reality. A `once: true`
 * script missing from the registry never runs and never shows as pending — the
 * silent failure this diff exists to make loud.
 */
export function findRegistryDrift(tracked: TrackedScript[], registry: readonly string[]): string[] {
  const problems: string[] = [];
  const registered = new Set(registry);
  const names = new Set(tracked.map((t) => t.name));

  for (const t of tracked) {
    if (t.once && !registered.has(t.name)) {
      problems.push(`${t.name} (${t.file}) is once:true but missing from _registry.ts — scripts:run will never run it`);
    }
    if (!t.once && registered.has(t.name)) {
      problems.push(`${t.name} (${t.file}) is once:false but listed in _registry.ts`);
    }
  }
  for (const name of registry) {
    if (!names.has(name)) problems.push(`${name} is listed in _registry.ts but no script registers that name`);
  }
  return problems;
}
