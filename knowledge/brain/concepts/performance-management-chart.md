---
title: Performance Management Chart (PMC)
type: concept
tags: [metric, planning, methodology, general]
status: active
created: 2026-06-05
updated: 2026-06-05
sources: ["[[src-icusync-ctl-atl-tsb]]", "[[src-trainerroad-tss-pmc]]"]
related: ["[[training-stress-score]]", "[[chronic-training-load]]", "[[acute-training-load]]", "[[training-stress-balance]]", "[[periodization]]", "[[tapering]]", "[[control-intensity-by-measurement]]", "[[muscular-load-limits-training]]"]
---

# Performance Management Chart (PMC)

> A simple fitness–fatigue model that turns daily training load (`[[training-stress-score]]`)
> into three rolling trend lines — **Fitness** (`[[chronic-training-load]]`), **Fatigue**
> (`[[acute-training-load]]`), and **Form** (`[[training-stress-balance]]`) — so you can time
> peaks and manage recovery.

## Why it matters

- Gives an **objective, week-over-week view of cumulative load** — the macro counterpart to the
  per-session intensity control in `[[control-intensity-by-measurement]]`. The TrainerRoad source
  argues that "without an objective way to measure your training load, properly structured
  training is not possible."
- Makes the build-vs-taper trade-off legible: you knowingly accumulate fatigue to build fitness,
  then shed it to surface form for a race (`[[periodization]]`, `[[tapering]]`).

## How it works

- Each workout scores a `[[training-stress-score]]` (TSS). The PMC then runs two rolling averages
  of daily TSS:
  - **CTL / Fitness** — slow ~**42-day** average (`[[chronic-training-load]]`).
  - **ATL / Fatigue** — fast ~**7-day** average (`[[acute-training-load]]`).
  - **TSB / Form = CTL − ATL** (`[[training-stress-balance]]`) — yesterday's freshness.
- **Cycle pattern:** in a **build**, ATL rises faster than CTL → TSB goes negative (intentional
  fatigue). In a **taper**, ATL drops fast while CTL holds → TSB climbs positive. After a race,
  CTL decays slowly and ATL falls toward zero.

## Key facts

- These are **"models, not measurements"** — useful trends, not physiological truth. They depend
  on the quality of the load data and are best read **alongside perceived effort and recovery**
  (`[[src-icusync-ctl-atl-tsb]]`).
- The model treats load as a single scalar, so it **cannot see *what kind* of stress** you took —
  "not all TSS is created equal," and in running it is blind to accumulated **muscular** load
  (`[[muscular-load-limits-training]]`). Use it as a coarse planning layer, not a verdict.

## See also

- `[[chronic-training-load]]` · `[[acute-training-load]]` · `[[training-stress-balance]]` · `[[training-stress-score]]` · `[[tapering]]`
