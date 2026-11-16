/**
 * The analytics time ranges. A fixed set rather than arbitrary dates: it
 * bounds the cost of the most expensive query in the system, and gives each
 * chart a sensible number of points.
 */
export const ANALYTICS_RANGES = {
  "24h": { durationSeconds: 24 * 3_600, bucketSeconds: 3_600 },
  "7d": { durationSeconds: 7 * 24 * 3_600, bucketSeconds: 6 * 3_600 },
  "30d": { durationSeconds: 30 * 24 * 3_600, bucketSeconds: 24 * 3_600 },
} as const;

export type AnalyticsRange = keyof typeof ANALYTICS_RANGES;

export const ANALYTICS_RANGE_KEYS = Object.keys(ANALYTICS_RANGES) as [
  AnalyticsRange,
  ...AnalyticsRange[],
];

/**
 * How long raw check results are kept. It must cover the longest analytics
 * range, or the 30-day view would silently show less than 30 days.
 */
export const DEFAULT_RETENTION_DAYS = 30;
