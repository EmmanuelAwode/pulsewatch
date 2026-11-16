export type MonitorStatus = "PENDING" | "UP" | "DOWN";

export interface MonitorState {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export interface Thresholds {
  /** Consecutive failures that take a monitor DOWN (default 3). */
  failureThreshold: number;
  /** Consecutive successes that bring a DOWN monitor back UP (default 2). */
  recoveryThreshold: number;
}

/**
 * What a check changed, if anything:
 *   WENT_DOWN   the failure threshold was reached: open an incident.
 *   RECOVERED   a DOWN monitor reached the recovery threshold: resolve it.
 *   FIRST_UP    a new monitor's first success. No incident is involved.
 */
export type Transition = "WENT_DOWN" | "RECOVERED" | "FIRST_UP" | null;

/**
 * The monitor's state machine as a pure function: no database, no clock.
 *
 *   PENDING --first success--------------> UP
 *   PENDING --failures reach threshold---> DOWN  (incident opens)
 *   UP      --failures reach threshold---> DOWN  (incident opens)
 *   DOWN    --successes reach threshold--> UP    (incident resolves)
 *
 * The thresholds give hysteresis: a single dropped request does not page
 * anyone, and a single lucky success does not declare an outage over. That
 * stops a flapping endpoint from opening and closing an incident on every
 * check.
 */
export function applyCheck(
  state: MonitorState,
  thresholds: Thresholds,
  success: boolean,
): { next: MonitorState; transition: Transition } {
  if (success) {
    const consecutiveSuccesses = state.consecutiveSuccesses + 1;
    const counters = { consecutiveSuccesses, consecutiveFailures: 0 };

    if (state.status === "PENDING") {
      return { next: { status: "UP", ...counters }, transition: "FIRST_UP" };
    }
    if (state.status === "DOWN" && consecutiveSuccesses >= thresholds.recoveryThreshold) {
      return { next: { status: "UP", ...counters }, transition: "RECOVERED" };
    }
    return { next: { status: state.status, ...counters }, transition: null };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const counters = { consecutiveFailures, consecutiveSuccesses: 0 };
  if (state.status !== "DOWN" && consecutiveFailures >= thresholds.failureThreshold) {
    return { next: { status: "DOWN", ...counters }, transition: "WENT_DOWN" };
  }
  return { next: { status: state.status, ...counters }, transition: null };
}
