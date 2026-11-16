import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import type { LiveEvent } from "@pulsewatch/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createCheckProcessor, type RecordedCheck } from "../src/checks/processor.js";
import type { Prober, ProbeResult } from "../src/probe/prober.js";
import { createMonitor, createUser, resetDatabase, secondsAfterT0, T0 } from "./helpers.js";

/**
 * Incident detection end to end through the check processor and a real
 * PostgreSQL: the state machine, incident rows, the notification outbox and
 * the live events emitted after commit.
 */

const UP: ProbeResult = { success: true, statusCode: 200, responseTimeMs: 80 };
const DOWN: ProbeResult = {
  success: false,
  statusCode: 503,
  responseTimeMs: 40,
  errorType: "HTTP_STATUS",
  errorMessage: "The endpoint responded with HTTP 503.",
};

let db: PrismaClient;
let userId: string;
let recorded: RecordedCheck[];

beforeAll(() => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(db);
  userId = await createUser(db);
  recorded = [];
});

/**
 * Runs one check per character of `sequence` ("S"/"F"), one minute apart,
 * starting at T0. Returns the processor's view of the monitor afterwards.
 */
async function runSequence(monitorId: string, sequence: string, startMinute = 0) {
  let index = 0;
  const results = Array.from(sequence, (step) => (step === "S" ? UP : DOWN));
  const probe: Prober = () => Promise.resolve(results[index++] ?? UP);
  const process = createCheckProcessor({
    db,
    probe,
    now: () => T0,
    onRecorded: (record) => {
      recorded.push(record);
      return Promise.resolve();
    },
  });
  for (let step = 0; step < results.length; step += 1) {
    await process({
      monitorId,
      scheduledFor: secondsAfterT0((startMinute + step) * 60).toISOString(),
    });
  }
  return db.monitor.findUniqueOrThrow({ where: { id: monitorId } });
}

function eventTypes(): string[] {
  return recorded.flatMap((record) => record.events.map((event: LiveEvent) => event.type));
}

async function enableEmail(overrides: object = {}) {
  await db.notificationSettings.create({
    data: { userId, emailEnabled: true, notifyOnDown: true, notifyOnRecovery: true, ...overrides },
  });
}

describe("going down", () => {
  it("opens one incident on the third failure, dated from the first", async () => {
    const monitor = await createMonitor(db, userId);

    const after = await runSequence(monitor.id, "SFFF");
    const incidents = await db.incident.findMany({ where: { monitorId: monitor.id } });

    expect(after.status).toBe("DOWN");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      resolvedAt: null,
      causeErrorType: "HTTP_STATUS",
      causeStatusCode: 503,
      causeMessage: "The endpoint responded with HTTP 503.",
    });
    // Failures were at minutes 1, 2, 3: the outage began at minute 1.
    expect(incidents[0]?.startedAt.toISOString()).toBe(secondsAfterT0(60).toISOString());
  });

  it("does not open an incident before the threshold", async () => {
    const monitor = await createMonitor(db, userId);

    const after = await runSequence(monitor.id, "SFF");

    expect(after.status).toBe("UP");
    expect(await db.incident.count()).toBe(0);
  });

  it("keeps a single incident however long the outage lasts", async () => {
    const monitor = await createMonitor(db, userId);

    await runSequence(monitor.id, "SFFFFFFFF");

    expect(await db.incident.count({ where: { monitorId: monitor.id } })).toBe(1);
  });

  it("emits status and incident events after commit", async () => {
    const monitor = await createMonitor(db, userId);

    await runSequence(monitor.id, "SFFF");

    expect(eventTypes()).toEqual([
      "check.completed",
      "monitor.status_changed",
      "check.completed",
      "check.completed",
      "check.completed",
      "monitor.status_changed",
      "incident.opened",
    ]);
    expect(recorded.every((record) => record.userId === userId)).toBe(true);
  });

  it("opens one incident when the threshold-crossing checks are stored at the same moment", async () => {
    const monitor = await createMonitor(db, userId);
    await runSequence(monitor.id, "SFF");
    const process = createCheckProcessor({ db, probe: () => Promise.resolve(DOWN), now: () => T0 });

    // Minutes 3 to 7 all fail and are stored concurrently. Without the row
    // lock, several could read "2 failures" and each open an incident.
    await Promise.all(
      [3, 4, 5, 6, 7].map((minute) =>
        process({ monitorId: monitor.id, scheduledFor: secondsAfterT0(minute * 60).toISOString() }),
      ),
    );

    expect(await db.incident.count({ where: { monitorId: monitor.id } })).toBe(1);
    expect((await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } })).status).toBe("DOWN");
  });
});

describe("recovering", () => {
  it("resolves the incident on the second success, dated from the first", async () => {
    const monitor = await createMonitor(db, userId);

    const after = await runSequence(monitor.id, "SFFFSS");
    const incident = await db.incident.findFirstOrThrow({ where: { monitorId: monitor.id } });

    expect(after.status).toBe("UP");
    // Successes at minutes 4 and 5: the outage ended at minute 4.
    expect(incident.resolvedAt?.toISOString()).toBe(secondsAfterT0(240).toISOString());
    expect(eventTypes().at(-1)).toBe("incident.resolved");
  });

  it("does not resolve on a single success between failures", async () => {
    const monitor = await createMonitor(db, userId);

    const after = await runSequence(monitor.id, "SFFFSF");

    expect(after.status).toBe("DOWN");
    expect(await db.incident.count({ where: { resolvedAt: null } })).toBe(1);
  });

  it("opens a second, separate incident for a later outage", async () => {
    const monitor = await createMonitor(db, userId);

    await runSequence(monitor.id, "SFFFSSFFF");
    const incidents = await db.incident.findMany({
      where: { monitorId: monitor.id },
      orderBy: { startedAt: "asc" },
    });

    expect(incidents).toHaveLength(2);
    expect(incidents[0]?.resolvedAt).not.toBeNull();
    expect(incidents[1]?.resolvedAt).toBeNull();
    expect(incidents[1]?.startedAt.toISOString()).toBe(secondsAfterT0(360).toISOString());
  });
});

describe("notification outbox", () => {
  it("queues nothing when email alerts are not enabled (the default)", async () => {
    const monitor = await createMonitor(db, userId);

    await runSequence(monitor.id, "SFFFSS");

    expect(await db.notificationDelivery.count()).toBe(0);
  });

  it("queues one email when an incident opens and one when it resolves", async () => {
    await enableEmail();
    const monitor = await createMonitor(db, userId);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

    await runSequence(monitor.id, "SFFFFSS");
    const deliveries = await db.notificationDelivery.findMany({ orderBy: { createdAt: "asc" } });

    expect(deliveries.map((delivery) => delivery.event)).toEqual([
      "INCIDENT_OPENED",
      "INCIDENT_RESOLVED",
    ]);
    expect(deliveries.every((delivery) => delivery.recipient === user.email)).toBe(true);
    expect(deliveries.every((delivery) => delivery.status === "PENDING")).toBe(true);
  });

  it("respects the per-event preferences", async () => {
    await enableEmail({ notifyOnDown: false });
    const monitor = await createMonitor(db, userId);

    await runSequence(monitor.id, "SFFFSS");
    const deliveries = await db.notificationDelivery.findMany();

    expect(deliveries.map((delivery) => delivery.event)).toEqual(["INCIDENT_RESOLVED"]);
  });

  it("queues nothing for a flapping endpoint that never crosses the threshold", async () => {
    await enableEmail();
    const monitor = await createMonitor(db, userId);

    await runSequence(monitor.id, "SFFSFFSFFS");

    expect(await db.notificationDelivery.count()).toBe(0);
  });
});
