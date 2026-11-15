import type { TestProject } from "vitest/node";
import { createTestDatabase } from "../src/testing/index.js";

declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Runs once before all test files: provisions a migrated database and hands
 * its URL to the tests. The returned function runs once after the last test.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase();
  project.provide("databaseUrl", database.url);
  return database.teardown;
}
