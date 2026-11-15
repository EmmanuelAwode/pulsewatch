import { randomUUID } from "node:crypto";
import type { Monitor, PrismaClient } from "@pulsewatch/database";
import type { Logger } from "../src/runtime.js";

/** A fixed instant, so no test depends on the wall clock. */
export const T0 = new Date("2026-01-01T12:00:00.000Z");

export function secondsAfterT0(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** Empties every table. All of them hang off `users` through ON DELETE CASCADE. */
export async function resetDatabase(db: PrismaClient): Promise<void> {
  await db.$executeRaw`TRUNCATE TABLE users CASCADE`;
}

export async function createUser(db: PrismaClient): Promise<string> {
  const user = await db.user.create({
    data: { email: `user-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" },
  });
  return user.id;
}

export async function createMonitor(
  db: PrismaClient,
  userId: string,
  overrides: Partial<Pick<Monitor, "nextCheckAt" | "intervalSeconds" | "paused" | "url">> = {},
): Promise<Monitor> {
  return db.monitor.create({
    data: {
      userId,
      name: "Example API",
      url: "https://api.example.com/health",
      nextCheckAt: T0,
      ...overrides,
    },
  });
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Polls until `condition` returns a value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  condition: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
