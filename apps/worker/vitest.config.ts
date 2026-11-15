import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One Postgres database and one Redis for the whole run (test/global-setup.ts).
    globalSetup: ["test/global-setup.ts"],
    // The scheduler claims EVERY due monitor in the database, so test files
    // that touch the database must not run at the same time as each other.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
