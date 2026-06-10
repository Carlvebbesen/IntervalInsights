---
title: Training Stress Score (TSS)
type: concept
tags: [metric, planning, bike, general]
status: active
created: 2026-06-05
updated: 2026-06-05
sources: ["[[src-trainerroad-tss-pmc]]"]
related: ["[[performance-management-chart]]", "[[chronic-training-load]]", "[[acute-training-load]]", "[[functional-threshold-power]]", "[[training-zones]]", "[[muscular-load-limits-training]]"]
---

# Training Stress Score (TSS)

> A single number for **how much physiological stress one workout cost**, combining its intensity
> and duration — the daily input the `[[performance-management-chart]]` is built from.

## Why it matters

- Lets you "balance adaptive stress with proper recovery" and compare otherwise unlike sessions
  on one scale.
- It is the atom of load modelling: `[[chronic-training-load]]` and `[[acute-training-load]]` are
  just rolling averages of daily TSS.

## How it's calculated

- Power-based formula (`[[src-trainerroad-tss-pmc]]`):
  `TSS = (seconds × Normalized Power × Intensity Factor) / (FTP × 3600) × 100`.
- **Anchor:** riding **one hour at `[[functional-threshold-power|FTP]]`** scores **TSS = 100**.
- **Normalized Power** estimates the metabolic cost of a variable effort; **Intensity Factor (IF)**
  is that effort relative to FTP (1.0 = at threshold). Running/HR analogues (hrTSS, rTSS) apply the
  same idea without a power meter.

## Key facts

- **"Not all TSS is created equal."** An easy 2 h ride and an intense sub-hour session can post the
  **same TSS** yet drive different adaptations — always read **IF alongside TSS** to know what kind
  of stress it was.
- Because it collapses a session to one scalar, TSS is **blind to the kind of load**: in running it
  does not capture accumulated muscular cost (`[[muscular-load-limits-training]]`,
  `[[training-zones]]`).

## See also

- `[[performance-management-chart]]` · `[[functional-threshold-power]]` · `[[chronic-training-load]]` · `[[acute-training-load]]`
