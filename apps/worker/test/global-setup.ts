import { createTestDatabase } from "@pulsewatch/database/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/**
 * Redis for the test run: an existing server if TEST_REDIS_URL is set,
 * otherwise a throwaway container. Tests give every queue a unique name, so a
 * shared server is safe.
 */
async function startRedis(): Promise<{ url: string; stop: () => Promise<void> }> {
  const existing = process.env["TEST_REDIS_URL"];
  if (existing) return { url: existing, stop: () => Promise.resolve() };

  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withCommand(["redis-server", "--maxmemory-policy", "noeviction"])
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [database, redis] = await Promise.all([createTestDatabase(), startRedis()]);
  project.provide("databaseUrl", database.url);
  project.provide("redisUrl", redis.url);
  return async () => {
    await Promise.all([database.teardown(), redis.stop()]);
  };
}
