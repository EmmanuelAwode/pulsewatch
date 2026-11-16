import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { Email, Mailer } from "../src/notifications/mailer.js";
import { createNotificationSender, retryDelayMs } from "../src/notifications/sender.js";
import { formatDuration, renderAlert } from "../src/notifications/templates.js";
import { createMonitor, createUser, resetDatabase, secondsAfterT0, T0 } from "./helpers.js";

let db: PrismaClient;
let userId: string;
let incidentId: string;

beforeAll(() => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(db);
  userId = await createUser(db);
  const monitor = await createMonitor(db, userId, { url: "https://api.example.com/health" });
  const incident = await db.incident.create({
    data: {
      monitorId: monitor.id,
      startedAt: T0,
      resolvedAt: secondsAfterT0(305),
      causeErrorType: "TIMEOUT",
      causeMessage: "No response within 10000 ms.",
    },
  });
  incidentId = incident.id;
});

function capturingMailer() {
  const sent: Email[] = [];
  const mailer: Mailer = (email) => {
    sent.push(email);
    return Promise.resolve();
  };
  return { sent, mailer };
}

async function queue(event: "INCIDENT_OPENED" | "INCIDENT_RESOLVED", nextAttemptAt = T0) {
  return db.notificationDelivery.create({
    data: { incidentId, event, channel: "EMAIL", recipient: "owner@example.com", nextAttemptAt },
  });
}

describe("renderAlert", () => {
  it("describes an outage", () => {
    const email = renderAlert({
      event: "INCIDENT_OPENED",
      recipient: "owner@example.com",
      monitorName: "Checkout API",
      monitorUrl: "https://api.example.com/health",
      startedAt: T0,
      resolvedAt: null,
      causeMessage: "No response within 10000 ms.",
    });

    expect(email.subject).toBe("[PulseWatch] DOWN: Checkout API");
    expect(email.text).toContain("Since:   2026-01-01T12:00:00.000Z (UTC)");
    expect(email.text).toContain("Reason:  No response within 10000 ms.");
  });

  it("describes a recovery with its duration", () => {
    const email = renderAlert({
      event: "INCIDENT_RESOLVED",
      recipient: "owner@example.com",
      monitorName: "Checkout API",
      monitorUrl: "https://api.example.com/health",
      startedAt: T0,
      resolvedAt: secondsAfterT0(3_900),
      causeMessage: null,
    });

    expect(email.subject).toBe("[PulseWatch] RECOVERED: Checkout API");
    expect(email.text).toContain("Duration:  1 h 5 min");
  });

  it.each([
    [0, "0 s"],
    [45_000, "45 s"],
    [200_000, "3 min 20 s"],
    [3_900_000, "1 h 5 min"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("notification sender", () => {
  it("sends a due notification and marks it SENT", async () => {
    const delivery = await queue("INCIDENT_OPENED");
    const { sent, mailer } = capturingMailer();

    const result = await createNotificationSender({ db, mailer, now: () => T0 }).sweep();
    const stored = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });

    expect(result).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      subject: "[PulseWatch] DOWN: Example API",
    });
    expect(stored).toMatchObject({ status: "SENT", attempts: 1, lastError: null });
  });

  it("never sends the same notification twice across sweeps", async () => {
    await queue("INCIDENT_OPENED");
    const { sent, mailer } = capturingMailer();
    const sender = createNotificationSender({ db, mailer, now: () => T0 });

    await sender.sweep();
    await sender.sweep();

    expect(sent).toHaveLength(1);
  });

  it("does not send before the retry time", async () => {
    await queue("INCIDENT_OPENED", secondsAfterT0(60));
    const { sent, mailer } = capturingMailer();

    await createNotificationSender({ db, mailer, now: () => T0 }).sweep();

    expect(sent).toHaveLength(0);
  });

  it("schedules a retry with backoff when sending fails, then gives up", async () => {
    const delivery = await queue("INCIDENT_OPENED");
    const failing: Mailer = () =>
      Promise.reject(new Error("connect ECONNREFUSED\r\nsmtp.internal:587"));
    let clock = T0;
    const sender = createNotificationSender({
      db,
      mailer: failing,
      now: () => clock,
      maxAttempts: 3,
    });

    expect(await sender.sweep()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    let stored = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(stored).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(stored.nextAttemptAt.getTime()).toBe(T0.getTime() + retryDelayMs(1));
    // Control characters are stripped from the stored error.
    expect(stored.lastError).toBe("connect ECONNREFUSED smtp.internal:587");

    // Not due yet: nothing happens.
    expect(await sender.sweep()).toEqual({ sent: 0, retrying: 0, failed: 0 });

    clock = new Date(T0.getTime() + retryDelayMs(1));
    expect(await sender.sweep()).toEqual({ sent: 0, retrying: 1, failed: 0 });

    clock = new Date(clock.getTime() + retryDelayMs(2));
    expect(await sender.sweep()).toEqual({ sent: 0, retrying: 0, failed: 1 });
    stored = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(stored).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("sends each notification once when two senders run at the same time", async () => {
    await queue("INCIDENT_OPENED");
    await queue("INCIDENT_RESOLVED");
    const sent: string[] = [];
    // A slow mailer keeps each delivery's row lock held while the other
    // sender looks for work.
    const slow: Mailer = async (email) => {
      sent.push(email.subject);
      await new Promise((resolve) => setTimeout(resolve, 150));
    };

    await Promise.all([
      createNotificationSender({ db, mailer: slow, now: () => T0 }).sweep(),
      createNotificationSender({ db, mailer: slow, now: () => T0 }).sweep(),
    ]);

    expect(sent.sort()).toEqual([
      "[PulseWatch] DOWN: Example API",
      "[PulseWatch] RECOVERED: Example API",
    ]);
    expect(await db.notificationDelivery.count({ where: { status: "SENT" } })).toBe(2);
  });
});
