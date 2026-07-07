#!/usr/bin/env bash
# One-shot verify: tests + typecheck + lint. Runs all three and reports every
# failure (no fail-fast), so one run gives the full picture.
# tsc output is filtered to src/ — tests are intentionally type-loose (mocks cast
# past interfaces) and are not part of the type gate.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "==> bun run test"
bash scripts/test.sh || fail=1

echo "==> tsc --noEmit (src/ only)"
tsc_out=$(bunx tsc --noEmit 2>&1 | grep '^src/' || true)
if [ -n "$tsc_out" ]; then
  echo "$tsc_out"
  fail=1
else
  echo "  ok"
fi

echo "==> biome check src"
bunx biome check src || fail=1

if [ "$fail" -eq 0 ]; then
  echo "CHECK PASSED"
else
  echo "CHECK FAILED" >&2
fi
exit "$fail"
