import { describe, expect, it } from "vitest";
import { slotStart } from "./monitoring.js";

describe("slotStart", () => {
  it("rounds down to the start of the interval", () => {
    const result = slotStart(new Date("2026-01-01T12:00:59.999Z"), 60);
    expect(result.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("leaves a timestamp already on a boundary unchanged", () => {
    const boundary = new Date("2026-01-01T12:05:00.000Z");
    expect(slotStart(boundary, 300).getTime()).toBe(boundary.getTime());
  });

  it("maps every instant inside a slot to the same slot", () => {
    const a = slotStart(new Date("2026-01-01T12:05:00.001Z"), 300);
    const b = slotStart(new Date("2026-01-01T12:09:59.000Z"), 300);
    expect(a.getTime()).toBe(b.getTime());
  });

  it("puts adjacent slots exactly one interval apart", () => {
    const a = slotStart(new Date("2026-01-01T12:00:30.000Z"), 60);
    const b = slotStart(new Date("2026-01-01T12:01:30.000Z"), 60);
    expect(b.getTime() - a.getTime()).toBe(60_000);
  });

  it.each([0, -60, 1.5, Number.NaN])("rejects an invalid interval (%s)", (interval) => {
    expect(() => slotStart(new Date(), interval)).toThrow(RangeError);
  });
});
