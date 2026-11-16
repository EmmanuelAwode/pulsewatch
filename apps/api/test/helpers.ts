import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import type { AppDependencies } from "../src/app.js";

export const APP_ORIGIN = "https://app.pulsewatch.test";

/** Not a real secret: a fixed value so token tests are deterministic. */
export const TEST_ACCESS_SECRET = "test-only-access-secret-0123456789abcdef";

/**
 * Configuration for an app under test. Rate limits are set high so that tests
 * which register many users from one address are not throttled; the
 * rate-limit tests pass their own low limits. Each app gets its own Redis key
 * prefix, so counters never leak between tests.
 */
export function testConfig(
  overrides: Partial<AppDependencies["config"]> = {},
): AppDependencies["config"] {
  return {
    logLevel: "silent",
    docsEnabled: true,
    redisUrl: inject("redisUrl"),
    trustProxy: false,
    auth: {
      accessSecret: TEST_ACCESS_SECRET,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 7 * 24 * 60 * 60,
      cookieSecure: true,
      appOrigin: APP_ORIGIN,
    },
    rateLimit: {
      perMinute: 100_000,
      authPerMinute: 100_000,
      keyPrefix: `test-rl-${randomUUID()}:`,
    },
    ...overrides,
  };
}
