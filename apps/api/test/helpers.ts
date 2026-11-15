import type { AppDependencies } from "../src/app.js";

export const APP_ORIGIN = "https://app.pulsewatch.test";

/** Not a real secret: a fixed value so token tests are deterministic. */
export const TEST_ACCESS_SECRET = "test-only-access-secret-0123456789abcdef";

export function testConfig(
  overrides: Partial<AppDependencies["config"]> = {},
): AppDependencies["config"] {
  return {
    logLevel: "silent",
    docsEnabled: true,
    auth: {
      accessSecret: TEST_ACCESS_SECRET,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 7 * 24 * 60 * 60,
      cookieSecure: true,
      appOrigin: APP_ORIGIN,
    },
    ...overrides,
  };
}
