import { randomUUID } from "node:crypto";
import type { Monitor, PrismaClient, User } from "../src/index.js";

/** A fixed instant, so tests never depend on the wall clock. */
export const T0 = new Date("2026-01-01T00:00:00.000Z");

/** T0 plus a number of minutes. */
export function minutesAfterT0(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/**
 * Every test creates its own user and works only inside that user's data.
 * Tests therefore cannot interfere with each other and need no table
 * truncation between them. The email is unique per call; every other value
 * is fixed.
 */
export async function createUser(db: PrismaClient): Promise<User> {
  return db.user.create({
    data: { email: `user-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" },
  });
}

export async function createMonitor(
  db: PrismaClient,
  userId: string,
  overrides: Partial<{ url: string; intervalSeconds: number; timeoutMs: number }> = {},
): Promise<Monitor> {
  return db.monitor.create({
    data: {
      userId,
      name: "Example API",
      url: "https://example.com/health",
      nextCheckAt: T0,
      ...overrides,
    },
  });
}
