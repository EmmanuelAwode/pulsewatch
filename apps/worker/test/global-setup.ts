import { createTestDatabase, createTestRedis } from "@pulsewatch/database/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  project.provide("databaseUrl", database.url);
  project.provide("redisUrl", redis.url);
  return async () => {
    await Promise.all([database.teardown(), redis.stop()]);
  };
}
