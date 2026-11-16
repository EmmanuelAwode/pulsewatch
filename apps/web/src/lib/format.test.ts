import { describe, expect, it } from "vitest";
import {
  displayUrl,
  errorLabel,
  formatDuration,
  formatInterval,
  formatMs,
  formatPercent,
  formatRelative,
  NO_DATA,
} from "./format";

describe("formatPercent", () => {
  it("never rounds a near-perfect figure up to 100%", () => {
    expect(formatPercent(99.996)).toBe("100.00%");
    expect(formatPercent(99.996, 3)).toBe("99.996%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("shows missing data as a dash, not 0%", () => {
    expect(formatPercent(null)).toBe(NO_DATA);
    expect(formatPercent(0)).toBe("0.00%");
  });
});

describe("formatMs", () => {
  it.each([
    [null, NO_DATA],
    [0, "0 ms"],
    [87.4, "87 ms"],
    [1_234, "1,234 ms"],
    [12_500, "12.5 s"],
  ])("formats %s", (value, text) => {
    expect(formatMs(value)).toBe(text);
  });
});

describe("formatDuration", () => {
  it.each([
    [42, "42 s"],
    [180, "3 min"],
    [3_900, "1 h 5 min"],
    [7_200, "2 h"],
    [97_200, "1 d 3 h"],
  ])("formats %d seconds as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it.each([
    [null, "Never"],
    ["2026-01-01T11:59:55.000Z", "just now"],
    ["2026-01-01T11:59:30.000Z", "30 s ago"],
    ["2026-01-01T11:55:00.000Z", "5 min ago"],
    ["2026-01-01T09:30:00.000Z", "2 h 30 min ago"],
  ])("formats %s", (iso, text) => {
    expect(formatRelative(iso, now)).toBe(text);
  });
});

describe("small labels", () => {
  it("describes intervals", () => {
    expect(formatInterval(60)).toBe("Every minute");
    expect(formatInterval(300)).toBe("Every 5 min");
    expect(formatInterval(3_600)).toBe("Every hour");
  });

  it("shortens URLs for display", () => {
    expect(displayUrl("https://api.example.com/")).toBe("api.example.com");
    expect(displayUrl("https://api.example.com/v1/health")).toBe("api.example.com/v1/health");
  });

  it("names failure types, with the status code for HTTP errors", () => {
    expect(errorLabel("HTTP_STATUS", 503)).toBe("HTTP 503");
    expect(errorLabel("TIMEOUT")).toBe("Timeout");
    expect(errorLabel(null)).toBe(NO_DATA);
  });
});
