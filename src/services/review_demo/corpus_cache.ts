// Memoized accessor for the store-review demo corpus. The corpus derives every
// date from `now`, so it is cached per calendar day: repeated requests within a
// day reuse one build, and the data stays fresh across day boundaries.

import { buildDemoCorpus, type DemoCorpus } from "./corpus";

let cached: { key: string; corpus: DemoCorpus } | null = null;

export function getDemoCorpus(): DemoCorpus {
  const now = new Date();
  const key = now.toISOString().slice(0, 10);
  if (cached?.key !== key) {
    cached = { key, corpus: buildDemoCorpus(now) };
  }
  return cached.corpus;
}
