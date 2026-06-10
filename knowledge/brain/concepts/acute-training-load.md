---
title: Acute Training Load (ATL) — "Fatigue"
type: concept
tags: [metric, recovery, planning, general]
status: active
created: 2026-06-05
updated: 2026-06-05
sources: ["[[src-icusync-ctl-atl-tsb]]", "[[src-trainerroad-tss-pmc]]"]
related: ["[[performance-management-chart]]", "[[training-stress-score]]", "[[chronic-training-load]]", "[[training-stress-balance]]", "[[recovery-and-adaptation]]", "[[muscle-tone]]"]
---

# Acute Training Load (ATL) — "Fatigue"

> A fast **~7-day rolling average of daily `[[training-stress-score]]`** (exponentially weighted
> toward the most recent days) — the PMC's proxy for **current fatigue**.

## Why it matters

- Reflects the stress of the **last week** of work, so it spikes during hard blocks and falls
  quickly on easy days. Tracking it helps "forecast how much recovery you need for maximum fitness
  benefit" — the quantitative cue for `[[recovery-and-adaptation]]`.
- It is the fatigue half of `[[training-stress-balance]]` (TSB = CTL − ATL): when ATL outruns
  `[[chronic-training-load|CTL]]`, form goes negative.

## Key facts

- A session that feels unexpectedly hard often just reflects **high ATL from the preceding days**,
  not lost fitness (`[[src-icusync-ctl-atl-tsb]]`).
- Because ATL is a single scalar, it **does not see the slowest-recovering tissue** — in running
  that is usually the **muscle** (`[[muscle-tone]]`, `[[muscular-load-limits-training]]`), which a
  TSS-based number can miss. Read it with bodily signals (HRV, resting HR, heavy legs).
- The build/taper dynamic is driven by ATL: it rises fast to create training stress, then drops
  fast in a taper to release `[[training-stress-balance|form]]`.

## See also

- `[[performance-management-chart]]` · `[[chronic-training-load]]` · `[[training-stress-balance]]` · `[[recovery-and-adaptation]]`
