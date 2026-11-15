/**
 * Domain rules shared by the API (validation), the worker (state machine) and
 * the web app (form limits). One definition means the three cannot drift.
 *
 * The same bounds are enforced by CHECK constraints in the database. A test in
 * packages/database asserts that the two agree.
 */

/** How often a monitor may be checked. */
export const CHECK_INTERVAL_SECONDS = { min: 60, max: 86_400, default: 60 } as const;

/** How long one check may take before it counts as a failure. */
export const CHECK_TIMEOUT_MS = { min: 1_000, max: 30_000, default: 10_000 } as const;

/** Consecutive failed checks before a monitor is DOWN and an incident opens. */
export const FAILURE_THRESHOLD = { min: 1, max: 10, default: 3 } as const;

/** Consecutive successful checks before a DOWN monitor is UP again. */
export const RECOVERY_THRESHOLD = { min: 1, max: 10, default: 2 } as const;

export const MONITOR_NAME_MAX_LENGTH = 100;
export const MONITOR_URL_MAX_LENGTH = 2_048;

/**
 * Rounds a timestamp down to the start of the interval slot containing it.
 *
 * Every check is identified by (monitorId, slot start). Because the slot comes
 * from the schedule rather than from "now", a retried or duplicated job
 * computes the same slot and the database unique constraint rejects the
 * second write (ADR-003).
 */
export function slotStart(timestamp: Date, intervalSeconds: number): Date {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new RangeError(`intervalSeconds must be a positive integer, got ${intervalSeconds}`);
  }
  const intervalMs = intervalSeconds * 1_000;
  return new Date(Math.floor(timestamp.getTime() / intervalMs) * intervalMs);
}
