export const SEGMENTER_CONFIG = {
  laps: {
    minLapSeconds: 10,
    junkLapMinDistanceM: 5,
    junkLapMinSpeed: 0.5,
    boundaryMaxLaps: 5,
    boundaryHrFraction: 0.6,
    perRepSpeedFraction: 0.75,
    trailingCooldownSpeedFraction: 0.85,
    trailingCooldownDurationFraction: 1.25,
    trailingCooldownMinReps: 3,
  },

  speed: {
    windowSec: 10,
  },

  bouts: {
    minBoutSeconds: 10,
    minGapSeconds: 4,
    workPercentile: 0.75,
    restPercentile: 0.05,
    thresholdFraction: 0.5,
  },

  window: {
    workPercentile: 0.75,
    thresholdFraction: 0.5,
    minCoverage: 0.9,
  },

  template: {
    workPercentile: 0.6,
    restPercentile: 0.15,
    paceFallbackSeconds: 60,
    restLevelFloor: 0.3,
    estimateWorkPercentile: 0.75,
    estimateRestPercentile: 0.2,
  },

  snap: {
    windowSeconds: 45,
  },

  expand: {
    shortRepMaxSeconds: 90,
    shortDistanceMinRatio: 0.9,
  },

  clamp: {
    overlongTolerance: 0.15,
  },

  confidence: {
    snapWeight: 0.45,
    contrastWeight: 0.3,
    countWeight: 0.25,
    inferredFactor: 0.85,
    forcedCountFloor: 0.6,
  },

  cascade: {
    deterministicThreshold: 0.5,
    icuMinWorkBlocks: 2,
  },

  pelt: {
    enabled: true,
    minSizeSeconds: 8,
    penaltyScale: 1.2,
  },

  markov: {
    enabled: true,
    switchPenalty: 2.5,
  },

  hrLag: {
    enabled: true,
    maxSeconds: 30,
    minCorrelationGain: 0.02,
    fallbackWhenSpeedContrastBelow: 0.15,
  },
} as const;

export const SHORT_REP_EXPAND_MAX_SECONDS = SEGMENTER_CONFIG.expand.shortRepMaxSeconds;
export const OVERLONG_TOLERANCE = SEGMENTER_CONFIG.clamp.overlongTolerance;
