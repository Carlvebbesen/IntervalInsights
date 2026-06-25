/**
 * Single source of truth for every tuned constant ("god number") in the interval
 * segmentation cascade. These were fitted on a small corpus of real workouts (see
 * the brain entry `deterministic-interval-segmentation`), so they carry overfit
 * risk — keeping them here makes the surface area auditable and tunable in one
 * place instead of scattered across the segmenter. Grouped by the stage that uses
 * them. Anything imported elsewhere is re-exported from its original module so
 * call sites don't churn.
 */
export const SEGMENTER_CONFIG = {
  /** Lap classification (`classifyLaps`, `isJunkLap`). */
  laps: {
    /** A lap shorter than this many seconds is junk (auto-lap noise). */
    minLapSeconds: 10,
    /** Junk lap: under this distance (m) AND under `junkLapMinSpeed` m/s. */
    junkLapMinDistanceM: 5,
    junkLapMinSpeed: 0.5,
    /** ≤ this many meaningful laps → boundary mode (HR separates warmup/work). */
    boundaryMaxLaps: 5,
    /** Boundary HR gate: work laps are those with HR ≥ min + frac·(max−min). */
    boundaryHrFraction: 0.6,
    /** Per-rep mode: a work lap is one whose avg speed ≥ frac·max-lap-speed. */
    perRepSpeedFraction: 0.75,
  },

  /** Windowed speed derivation (`deriveSpeed`). */
  speed: {
    windowSec: 10,
  },

  /** Surge / bout detection on the speed signal (`detectBouts`). */
  bouts: {
    minBoutSeconds: 10,
    /** Adjacent high-speed runs closer than this (s) are merged (flicker). */
    minGapSeconds: 4,
    /** workLvl ≈ p75 of in-window speed, restLvl ≈ p05; gate = rest + frac·(work−rest). */
    workPercentile: 0.75,
    restPercentile: 0.05,
    thresholdFraction: 0.5,
  },

  /** Sliding work-window search (`detectWorkWindowBySpeed`). */
  window: {
    workPercentile: 0.75,
    thresholdFraction: 0.5,
    /** A candidate window must cover ≥ this fraction of the target structure secs. */
    minCoverage: 0.9,
  },

  /** Template placement (`templatePlace`) + structure-seconds estimate. */
  template: {
    workPercentile: 0.6,
    restPercentile: 0.15,
    /** Pace fallback (s) for a TIME rep when workLvl is unusable. */
    paceFallbackSeconds: 60,
    /** Only divide a DISTANCE rest by restLvl when restLvl exceeds this (m/s). */
    restLevelFloor: 0.3,
    estimateWorkPercentile: 0.75,
    estimateRestPercentile: 0.2,
  },

  /** Edge snapping (`templatePlace.snap`). */
  snap: {
    windowSeconds: 45,
  },

  /** Short-rep / short-distance recovery (`expandShortReps`, `expandShortDistanceReps`). */
  expand: {
    /** TIME reps ≤ this read short due to pace lag → expand symmetrically. */
    shortRepMaxSeconds: 90,
    /** Grow a DISTANCE bout when its covered distance is below this ratio of target. */
    shortDistanceMinRatio: 0.9,
  },

  /** Overlong-bout trimming (`clampOverlongBouts`). */
  clamp: {
    /** Trim only when a bout overruns its prescribed measure by more than this. */
    overlongTolerance: 0.15,
  },

  /** Confidence blend (`buildSegmentsDeterministic`). Weights should sum to 1. */
  confidence: {
    snapWeight: 0.45,
    contrastWeight: 0.3,
    countWeight: 0.25,
    /** Inferred (no-title) structures discount confidence — the count is a guess. */
    inferredFactor: 0.85,
    /** Count-guaranteed (title-authoritative) results are floored above the gate. */
    forcedCountFloor: 0.6,
  },

  /** Cascade gate (`produceSegments`) + intervals.icu rung (`buildSegmentsFromIntervalsIcu`). */
  cascade: {
    /** Below this deterministic confidence, fall through to the LLM segmenter. */
    deterministicThreshold: 0.5,
    /** Without an expected rep count, trust an icu breakdown only if ≥ this many WORK blocks. */
    icuMinWorkBlocks: 2,
  },

  /**
   * PELT change-point detection (`changepoint.ts`) — the principled multi-changepoint
   * core that replaces raw threshold surge detection. Penalty is the per-changepoint
   * cost in the PELT objective (higher → fewer segments); minSize guards short reps.
   */
  pelt: {
    enabled: true,
    /** Minimum segment length (s) — the short-rep guard (cf. 626's ~25 s reps). */
    minSizeSeconds: 8,
    /**
     * BIC-style penalty multiplier on log(n)·variance. Scaled by the signal variance
     * at call time so it adapts to noisy treadmill vs clean track data.
     */
    penaltyScale: 1.2,
  },

  /**
   * Markov / Viterbi label smoothing (`smoothBinaryLabels`) — a 2-state prior over
   * the per-sample work/rest labels that suppresses single-sample flicker, the
   * over-segmentation that pure thresholding produces (inference drift 504 24→20).
   */
  markov: {
    enabled: true,
    /** Cost (in the same units as the speed-distance term) of switching state. */
    switchPenalty: 2.5,
  },

  /**
   * HR-lag compensation (`hr_lag.ts`). Heart rate lags effort by ~10-30 s, so HR-based
   * gates land late; cross-correlate HR against speed and shift HR earlier by the best
   * lag before using it. icu flags this as an unfixed weakness (root cause of 626).
   */
  hrLag: {
    enabled: true,
    /** Search lags in [0, maxSeconds]; HR is shifted earlier by the best-correlating lag. */
    maxSeconds: 30,
    /** Don't apply a shift unless the best-lag correlation gain clears this margin. */
    minCorrelationGain: 0.02,
    /**
     * Detect on lag-compensated HR instead of speed when the speed signal can't
     * separate work from rest — (workLvl−restLvl)/workLvl below this (flat treadmill
     * speed / HR-only reps). On clean-speed data this never fires.
     */
    fallbackWhenSpeedContrastBelow: 0.15,
  },
} as const;

/** @deprecated import from SEGMENTER_CONFIG.expand.shortRepMaxSeconds — kept for call-site compat. */
export const SHORT_REP_EXPAND_MAX_SECONDS = SEGMENTER_CONFIG.expand.shortRepMaxSeconds;
/** @deprecated import from SEGMENTER_CONFIG.clamp.overlongTolerance — kept for call-site compat. */
export const OVERLONG_TOLERANCE = SEGMENTER_CONFIG.clamp.overlongTolerance;
