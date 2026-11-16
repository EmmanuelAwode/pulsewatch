import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { runRetention } from "../src/maintenance/retention.js";
import { createMonitor, createUser, resetDatabase, T0 } from "./helpers.js";

const DAY = 24 * 3_600_000;

let db: PrismaClient;
let userId: string;

beforeAll(() => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(db);
  userId = await createUser(db);
});

function daysBeforeT0(days: number): Date {
  return new Date(T0.getTime() - days * DAY);
}

describe("runRetention", () => {
  it("deletes check results older than the retention period and keeps the rest", async () => {
    const monitor = await createMonitor(db, userId);
    const ages = [45, 31, 30.5, 29.9, 1];
    await db.checkResult.createMany({
      data: ages.map((days) => ({
        monitorId: monitor.id,
        scheduledFor: daysBeforeT0(days),
        checkedAt: daysBeforeT0(days),
        success: true,
        statusCode: 200,
        responseTimeMs: 100,
      })),
    });

    const removed = await runRetention({ db, now: () => T0, retentionDays: 30, batchSize: 2 });
    const remaining = await db.checkResult.findMany({ orderBy: { scheduledFor: "asc" } });

    // batchSize 2 forces several delete statements for 3 old rows.
    expect(removed.checkResults).toBe(3);
    expect(remaining.map((row) => row.scheduledFor.toISOString())).toEqual([
      daysBeforeT0(29.9).toISOString(),
      daysBeforeT0(1).toISOString(),
    ]);
  });

  it("keeps incidents, which are the long-term record", async () => {
    const monitor = await createMonitor(db, userId);
    await db.incident.create({
      data: {
        monitorId: monitor.id,
        startedAt: daysBeforeT0(400),
        resolvedAt: daysBeforeT0(399),
        causeErrorType: "TIMEOUT",
      },
    });

    await runRetention({ db, now: () => T0, retentionDays: 30 });

    expect(await db.incident.count()).toBe(1);
  });

  it("removes expired sessions and long-revoked ones, but keeps live ones", async () => {
    const token = (suffix: string, expiresAt: Date, revokedAt: Date | null = null) => ({
      userId,
      familyId: userId,
      tokenHash: `hash-${suffix}`,
      expiresAt,
      revokedAt,
    });
    await db.refreshToken.createMany({
      data: [
        token("expired", daysBeforeT0(1)),
        token("revoked-long-ago", daysBeforeT0(-5), daysBeforeT0(8)),
        token("revoked-recently", daysBeforeT0(-5), daysBeforeT0(1)),
        token("live", daysBeforeT0(-5)),
      ],
    });

    const removed = await runRetention({ db, now: () => T0, retentionDays: 30 });
    const remaining = await db.refreshToken.findMany({ select: { tokenHash: true } });

    expect(removed.refreshTokens).toBe(2);
    expect(remaining.map((row) => row.tokenHash).sort()).toEqual([
      "hash-live",
      "hash-revoked-recently",
    ]);
  });
});
