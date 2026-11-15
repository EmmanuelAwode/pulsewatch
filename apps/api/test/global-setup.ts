import { createTestDatabase } from "@pulsewatch/database/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase();
  project.provide("databaseUrl", database.url);
  return database.teardown;
}
