import { describe, expect, it } from "vitest";
import { applyCheck, type MonitorState, type Transition } from "../src/checks/state-machine.js";

const thresholds = { failureThreshold: 3, recoveryThreshold: 2 };
const FRESH: MonitorState = { status: "PENDING", consecutiveFailures: 0, consecutiveSuccesses: 0 };

/** Feeds a sequence of results ("S" = success, "F" = failure) through the machine. */
function run(sequence: string, start: MonitorState = FRESH) {
  let state = start;
  const transitions: Transition[] = [];
  for (const step of sequence) {
    const { next, transition } = applyCheck(state, thresholds, step === "S");
    state = next;
    transitions.push(transition);
  }
  return { state, transitions };
}

describe("applyCheck", () => {
  it("marks a new monitor UP on its first success", () => {
    expect(run("S")).toEqual({
      state: { status: "UP", consecutiveFailures: 0, consecutiveSuccesses: 1 },
      transitions: ["FIRST_UP"],
    });
  });

  it("goes DOWN on exactly the third consecutive failure", () => {
    const { state, transitions } = run("SFFF");

    expect(transitions).toEqual(["FIRST_UP", null, null, "WENT_DOWN"]);
    expect(state.status).toBe("DOWN");
  });

  it("takes a new monitor straight from PENDING to DOWN if it never succeeds", () => {
    expect(run("FFF").transitions).toEqual([null, null, "WENT_DOWN"]);
  });

  it("does not report WENT_DOWN again while the outage continues", () => {
    const { state, transitions } = run("SFFFFFF");

    expect(transitions.filter((transition) => transition === "WENT_DOWN")).toHaveLength(1);
    expect(state.consecutiveFailures).toBe(6);
  });

  it("recovers on exactly the second consecutive success", () => {
    const { state, transitions } = run("SFFFSS");

    expect(transitions.slice(4)).toEqual([null, "RECOVERED"]);
    expect(state.status).toBe("UP");
  });

  it("stays DOWN when a single success is followed by another failure", () => {
    const { state, transitions } = run("SFFFSF");

    expect(state.status).toBe("DOWN");
    expect(transitions).not.toContain("RECOVERED");
  });

  it("ignores a flapping endpoint that never fails three times in a row", () => {
    const { state, transitions } = run("SFFSFFSFF");

    expect(state.status).toBe("UP");
    expect(transitions.slice(1).every((transition) => transition === null)).toBe(true);
  });

  it("honours custom thresholds", () => {
    const strict = { failureThreshold: 1, recoveryThreshold: 1 };
    const up: MonitorState = { status: "UP", consecutiveFailures: 0, consecutiveSuccesses: 4 };

    const down = applyCheck(up, strict, false);
    const back = applyCheck(down.next, strict, true);

    expect(down.transition).toBe("WENT_DOWN");
    expect(back.transition).toBe("RECOVERED");
  });
});
