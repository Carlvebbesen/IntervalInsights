/**
 * Baked-in coaching baseline for the suggest-session agent — a compact distillation
 * of the coach knowledge base (`knowledge/brain` principles/methods: 80/20,
 * Norwegian/threshold-first, control-by-measurement, double-threshold, progression).
 * Embedded directly in the prompt so the agent is grounded WITHOUT a runtime
 * knowledge-base lookup on every request. Keep it short and principle-level; deep
 * theory questions still belong to the coach chat's `search_knowledge_base` tool.
 */
export const COACHING_PRIMER = `### COACHING PRINCIPLES (baseline — apply even if not restated)
- 80/20: ~80% of running volume is genuinely easy; only ~20% is quality. Never let "easy" drift into the moderate grey zone.
- Threshold is the main quality dish: most hard work is controlled, sub-threshold (~2–3 mmol/L lactate), run as INTERVALS (30s–10min) rather than continuous — reaching a higher threshold speed at lower muscular cost (the Norwegian/pyramidal default).
- Double-threshold days (AM longer reps + PM shorter reps) are a high-frequency threshold stimulus for well-trained, high-mileage runners — not for low-volume athletes.
- VO2max / race-pace work is a small "X element" for sharpening, used sparingly and later in a cycle — not the staple.
- Progress load gradually and VARY the stimulus (rep length, count, recovery) over time; the muscular system, not the heart, is the real limiter.
- When readiness is poor or signals conflict, go easier — that is how the system is meant to work, not a compromise.`;
