import {
  CHECK_INTERVAL_SECONDS,
  CHECK_TIMEOUT_MS,
  FAILURE_THRESHOLD,
  RECOVERY_THRESHOLD,
} from "@pulsewatch/shared";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient, type PrismaClient } from "../src/index.js";
import { createMonitor, createUser, minutesAfterT0, T0 } from "./fixtures.js";

/**
 * These tests run against a real PostgreSQL database with the real migrations
 * applied. They exist because the guarantees below are made by the database,
 * not by application code, so only the database can prove them.
 */

let db: PrismaClient;

beforeAll(() => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
});

afterAll(async () => {
  await db.$disconnect();
});

const UNIQUE_VIOLATION = { code: "P2002" };

describe("migrations", () => {
  it("are recorded as applied, with none failed or rolled back", async () => {
    const rows = await db.$queryRaw<{ migration_name: string; finished: boolean }[]>`
      SELECT migration_name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished
      FROM _prisma_migrations ORDER BY started_at`;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.finished)).toBe(true);
  });
});

describe("client", () => {
  it("pins the session time zone to UTC whatever the server default is", async () => {
    // Guards ADR-013 directly. The DST round-trip test below only fails on a
    // server whose default zone is not UTC, and CI containers default to UTC,
    // so without this assertion CI could not catch the pin being removed.
    const rows = await db.$queryRaw<{ timezone: string }[]>`
      SELECT current_setting('TimeZone') AS timezone`;

    expect(rows[0]?.timezone).toBe("UTC");
  });
});

describe("users", () => {
  it("rejects a second account with the same email", async () => {
    const user = await createUser(db);

    await expect(
      db.user.create({ data: { email: user.email, passwordHash: "x" } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("rejects an email that is not lower-case", async () => {
    await expect(
      db.user.create({ data: { email: "Mixed.Case@Example.com", passwordHash: "x" } }),
    ).rejects.toThrow(/users_email_lowercase/);
  });

  it("deleting a user removes everything they own", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    await db.checkResult.create({
      data: {
        monitorId: monitor.id,
        scheduledFor: T0,
        checkedAt: T0,
        success: true,
        statusCode: 200,
        responseTimeMs: 120,
      },
    });
    const incident = await db.incident.create({
      data: { monitorId: monitor.id, startedAt: T0, causeErrorType: "TIMEOUT" },
    });
    await db.notificationDelivery.create({
      data: {
        incidentId: incident.id,
        event: "INCIDENT_OPENED",
        channel: "EMAIL",
        recipient: user.email,
      },
    });
    await db.notificationSettings.create({ data: { userId: user.id } });
    await db.refreshToken.create({
      data: {
        userId: user.id,
        familyId: user.id,
        tokenHash: `hash-${user.id}`,
        expiresAt: minutesAfterT0(60),
      },
    });

    await db.user.delete({ where: { id: user.id } });

    expect(await db.monitor.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.checkResult.count({ where: { monitorId: monitor.id } })).toBe(0);
    expect(await db.incident.count({ where: { monitorId: monitor.id } })).toBe(0);
    expect(await db.notificationDelivery.count({ where: { incidentId: incident.id } })).toBe(0);
    expect(await db.notificationSettings.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("monitors", () => {
  it("applies defaults that match the shared domain constants", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);

    expect(monitor).toMatchObject({
      intervalSeconds: CHECK_INTERVAL_SECONDS.default,
      timeoutMs: CHECK_TIMEOUT_MS.default,
      failureThreshold: FAILURE_THRESHOLD.default,
      recoveryThreshold: RECOVERY_THRESHOLD.default,
      method: "GET",
      status: "PENDING",
      paused: false,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    });
  });

  it("accepts the interval bounds and rejects values just outside them", async () => {
    const user = await createUser(db);

    // The bounds come from the shared constants, so this fails if the CHECK
    // constraint in the migration and the application rules ever disagree.
    await createMonitor(db, user.id, { intervalSeconds: CHECK_INTERVAL_SECONDS.min });
    await createMonitor(db, user.id, { intervalSeconds: CHECK_INTERVAL_SECONDS.max });

    await expect(
      createMonitor(db, user.id, { intervalSeconds: CHECK_INTERVAL_SECONDS.min - 1 }),
    ).rejects.toThrow(/monitors_interval_range/);
    await expect(
      createMonitor(db, user.id, { intervalSeconds: CHECK_INTERVAL_SECONDS.max + 1 }),
    ).rejects.toThrow(/monitors_interval_range/);
  });

  it("accepts the timeout bounds and rejects values just outside them", async () => {
    const user = await createUser(db);

    await createMonitor(db, user.id, { timeoutMs: CHECK_TIMEOUT_MS.min });
    await createMonitor(db, user.id, { timeoutMs: CHECK_TIMEOUT_MS.max });

    await expect(
      createMonitor(db, user.id, { timeoutMs: CHECK_TIMEOUT_MS.min - 1 }),
    ).rejects.toThrow(/monitors_timeout_range/);
    await expect(
      createMonitor(db, user.id, { timeoutMs: CHECK_TIMEOUT_MS.max + 1 }),
    ).rejects.toThrow(/monitors_timeout_range/);
  });

  it.each(["http://example.com", "ftp://example.com", "example.com"])(
    "rejects a URL that is not https (%s)",
    async (url) => {
      const user = await createUser(db);

      await expect(createMonitor(db, user.id, { url })).rejects.toThrow(/monitors_url_https/);
    },
  );
});

describe("check results", () => {
  const success = { success: true, statusCode: 200, responseTimeMs: 120 } as const;

  it("stores one result per monitor per slot", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    const slot = { monitorId: monitor.id, scheduledFor: T0, checkedAt: T0 };

    await db.checkResult.create({ data: { ...slot, ...success } });

    await expect(db.checkResult.create({ data: { ...slot, ...success } })).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
  });

  it("lets a retried write be skipped silently instead of failing", async () => {
    // This is the write the worker will use (INSERT ... ON CONFLICT DO NOTHING).
    // `count` tells it whether this delivery of the job is the first.
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    const row = { monitorId: monitor.id, scheduledFor: T0, checkedAt: T0, ...success };

    const first = await db.checkResult.createMany({ data: [row], skipDuplicates: true });
    const retry = await db.checkResult.createMany({ data: [row], skipDuplicates: true });

    expect(first.count).toBe(1);
    expect(retry.count).toBe(0);
    expect(await db.checkResult.count({ where: { monitorId: monitor.id } })).toBe(1);
  });

  it("allows the same slot for different monitors", async () => {
    const user = await createUser(db);
    const a = await createMonitor(db, user.id);
    const b = await createMonitor(db, user.id);

    await db.checkResult.create({
      data: { monitorId: a.id, scheduledFor: T0, checkedAt: T0, ...success },
    });
    await db.checkResult.create({
      data: { monitorId: b.id, scheduledFor: T0, checkedAt: T0, ...success },
    });

    expect(await db.checkResult.count({ where: { monitorId: { in: [a.id, b.id] } } })).toBe(2);
  });

  it("rejects a failure that does not say why", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);

    await expect(
      db.checkResult.create({
        data: { monitorId: monitor.id, scheduledFor: T0, checkedAt: T0, success: false },
      }),
    ).rejects.toThrow(/check_results_failure_shape/);
  });

  it("rejects a success without a status code and latency", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);

    await expect(
      db.checkResult.create({
        data: { monitorId: monitor.id, scheduledFor: T0, checkedAt: T0, success: true },
      }),
    ).rejects.toThrow(/check_results_success_shape/);
  });

  it("rejects a success that also carries an error", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);

    await expect(
      db.checkResult.create({
        data: {
          monitorId: monitor.id,
          scheduledFor: T0,
          checkedAt: T0,
          ...success,
          errorType: "TIMEOUT",
        },
      }),
    ).rejects.toThrow(/check_results_success_shape/);
  });

  it("round-trips timestamps as exact UTC instants", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    const scheduledFor = new Date("2026-03-29T01:30:00.000Z"); // inside a European DST change
    const checkedAt = new Date("2026-03-29T01:30:00.487Z");

    const created = await db.checkResult.create({
      data: { monitorId: monitor.id, scheduledFor, checkedAt, ...success },
    });
    const stored = await db.checkResult.findUniqueOrThrow({ where: { id: created.id } });

    expect(stored.scheduledFor.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(stored.checkedAt.toISOString()).toBe("2026-03-29T01:30:00.487Z");
  });

  it("returns a time range for one monitor in slot order", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    const other = await createMonitor(db, user.id);
    await db.checkResult.createMany({
      data: [0, 1, 2, 3, 4].flatMap((minute) =>
        [monitor.id, other.id].map((monitorId) => ({
          monitorId,
          scheduledFor: minutesAfterT0(minute),
          checkedAt: minutesAfterT0(minute),
          ...success,
        })),
      ),
    });

    const page = await db.checkResult.findMany({
      where: {
        monitorId: monitor.id,
        scheduledFor: { gte: minutesAfterT0(1), lt: minutesAfterT0(4) },
      },
      orderBy: { scheduledFor: "desc" },
    });

    expect(page.map((row) => row.scheduledFor.toISOString())).toEqual([
      "2026-01-01T00:03:00.000Z",
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:01:00.000Z",
    ]);
  });
});

describe("incidents", () => {
  it("allows only one open incident per monitor", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    await db.incident.create({
      data: { monitorId: monitor.id, startedAt: T0, causeErrorType: "TIMEOUT" },
    });

    await expect(
      db.incident.create({
        data: { monitorId: monitor.id, startedAt: minutesAfterT0(1), causeErrorType: "TIMEOUT" },
      }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("allows a new incident once the previous one is resolved", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    const first = await db.incident.create({
      data: { monitorId: monitor.id, startedAt: T0, causeErrorType: "TIMEOUT" },
    });
    await db.incident.update({
      where: { id: first.id },
      data: { resolvedAt: minutesAfterT0(5) },
    });

    await db.incident.create({
      data: { monitorId: monitor.id, startedAt: minutesAfterT0(10), causeErrorType: "HTTP_STATUS" },
    });

    expect(await db.incident.count({ where: { monitorId: monitor.id } })).toBe(2);
    expect(await db.incident.count({ where: { monitorId: monitor.id, resolvedAt: null } })).toBe(1);
  });

  it("opens exactly one incident when ten writers race", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        db.incident.create({
          data: { monitorId: monitor.id, startedAt: T0, causeErrorType: "TIMEOUT" },
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(await db.incident.count({ where: { monitorId: monitor.id } })).toBe(1);
  });

  it("rejects a resolution time earlier than the start", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);

    await expect(
      db.incident.create({
        data: {
          monitorId: monitor.id,
          startedAt: minutesAfterT0(5),
          resolvedAt: T0,
          causeErrorType: "TIMEOUT",
        },
      }),
    ).rejects.toThrow(/incidents_resolved_after_start/);
  });
});

describe("notifications", () => {
  it("records one delivery per incident, event and channel", async () => {
    const user = await createUser(db);
    const monitor = await createMonitor(db, user.id);
    const incident = await db.incident.create({
      data: { monitorId: monitor.id, startedAt: T0, causeErrorType: "TIMEOUT" },
    });
    const delivery = {
      incidentId: incident.id,
      channel: "EMAIL",
      recipient: user.email,
    } as const;

    await db.notificationDelivery.create({ data: { ...delivery, event: "INCIDENT_OPENED" } });
    // A different event for the same incident is a different notification.
    await db.notificationDelivery.create({ data: { ...delivery, event: "INCIDENT_RESOLVED" } });

    await expect(
      db.notificationDelivery.create({ data: { ...delivery, event: "INCIDENT_OPENED" } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("allows one settings row per user", async () => {
    const user = await createUser(db);
    await db.notificationSettings.create({ data: { userId: user.id } });

    await expect(
      db.notificationSettings.create({ data: { userId: user.id } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });
});

describe("refresh tokens", () => {
  it("rejects a duplicate token hash", async () => {
    const user = await createUser(db);
    const token = {
      userId: user.id,
      familyId: user.id,
      tokenHash: `duplicate-${user.id}`,
      expiresAt: minutesAfterT0(60),
    };
    await db.refreshToken.create({ data: token });

    await expect(db.refreshToken.create({ data: token })).rejects.toMatchObject(UNIQUE_VIOLATION);
  });
});
