import { describe, expect, it } from "vitest";
import { CHECK_INTERVAL_SECONDS } from "./monitoring.js";
import { createMonitorSchema, monitorUrlSchema, updateMonitorSchema } from "./monitors.js";

const valid = { name: "Checkout API", url: "https://api.example.com/health" };

describe("monitorUrlSchema", () => {
  it.each([
    "https://example.com",
    "https://api.example.com/v1/health?probe=1",
    "https://example.com:443/health",
  ])("accepts %s", (url) => {
    expect(monitorUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    ["http://example.com", "Only https:// URLs can be monitored."],
    ["ftp://example.com", "Only https:// URLs can be monitored."],
    ["file:///etc/passwd", "Only https:// URLs can be monitored."],
    ["javascript:alert(1)", "Only https:// URLs can be monitored."],
    ["example.com", "Enter a valid URL."],
    ["", "Enter a valid URL."],
    ["https://user:secret@example.com", "The URL must not contain credentials."],
    ["https://example.com:8443/admin", "Only the default HTTPS port (443) is allowed."],
    ["https://example.com:22", "Only the default HTTPS port (443) is allowed."],
  ])("rejects %s", (url, message) => {
    const result = monitorUrlSchema.safeParse(url);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it("rejects a URL longer than the limit", () => {
    const url = `https://example.com/${"a".repeat(2_048)}`;

    expect(monitorUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe("createMonitorSchema", () => {
  it("fills in defaults for every optional setting", () => {
    expect(createMonitorSchema.parse(valid)).toEqual({
      ...valid,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      failureThreshold: 3,
      recoveryThreshold: 2,
    });
  });

  it("trims the name and rejects one that is only whitespace", () => {
    expect(createMonitorSchema.parse({ ...valid, name: "  Checkout  " }).name).toBe("Checkout");
    expect(createMonitorSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("enforces the interval bounds", () => {
    const withInterval = (intervalSeconds: number) =>
      createMonitorSchema.safeParse({ ...valid, intervalSeconds }).success;

    expect(withInterval(CHECK_INTERVAL_SECONDS.min - 1)).toBe(false);
    expect(withInterval(CHECK_INTERVAL_SECONDS.min)).toBe(true);
    expect(withInterval(CHECK_INTERVAL_SECONDS.max)).toBe(true);
    expect(withInterval(CHECK_INTERVAL_SECONDS.max + 1)).toBe(false);
    expect(withInterval(90.5)).toBe(false);
  });

  it("rejects an HTTP method that could change state on the target", () => {
    expect(createMonitorSchema.safeParse({ ...valid, method: "POST" }).success).toBe(false);
    expect(createMonitorSchema.safeParse({ ...valid, method: "DELETE" }).success).toBe(false);
  });

  it("drops fields the client is not allowed to set", () => {
    const parsed = createMonitorSchema.parse({ ...valid, userId: "someone-else", status: "UP" });

    expect(parsed).not.toHaveProperty("userId");
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("updateMonitorSchema", () => {
  it("accepts a single field and adds no defaults", () => {
    expect(updateMonitorSchema.parse({ paused: true })).toEqual({ paused: true });
  });

  it("rejects an empty patch", () => {
    expect(updateMonitorSchema.safeParse({}).success).toBe(false);
  });

  it("applies the same rules as creation to the fields it is given", () => {
    expect(updateMonitorSchema.safeParse({ url: "http://example.com" }).success).toBe(false);
    expect(updateMonitorSchema.safeParse({ intervalSeconds: 5 }).success).toBe(false);
  });
});
