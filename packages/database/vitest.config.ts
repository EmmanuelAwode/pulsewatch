import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Creates one migrated database for the whole run (see test/global-setup.ts).
    globalSetup: ["test/global-setup.ts"],
    // Starting a container and applying migrations can take a while on a cold machine.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
