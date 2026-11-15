import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One migrated PostgreSQL database for the whole run (test/global-setup.ts).
    globalSetup: ["test/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
