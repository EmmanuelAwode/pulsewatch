import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { checkJobId, type CheckJob } from "../src/checks/job.js";
import { createScheduler, currentAndNextSlot } from "../src/checks/scheduler.js";
import { createMonitor, createUser, resetDatabase, secondsAfterT0, T0 } from "./helpers.js";

/**
 * The scheduler against a real PostgreSQL. The queue is replaced by a
 * function that records what it was given, so each test can see exactly which
 * jobs would have been enqueued (and can make enqueueing fail on demand).
 */

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

function recordingQueue() {
  const jobs: CheckJob[] = [];
  return {
    jobs,
    enqueue: (batch: CheckJob[]) => {
      jobs.push(...batch);
      return Promise.resolve();
    },
  };
}

async function nextCheckAt(monitorId: string): Promise<string> {
  const monitor = await db.monitor.findUniqueOrThrow({ where: { id: monitorId } });
  return monitor.nextCheckAt.toISOString();
}

describe("currentAndNextSlot", () => {
  it("uses the due time itself when the monitor is on schedule", () => {
    const { slot, next } = currentAndNextSlot(T0, 60, secondsAfterT0(1));

    expect(slot.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(next.toISOString()).toBe("2026-01-01T12:01:00.000Z");
  });

  it("skips forward to the latest slot after downtime, staying on the monitor's grid", () => {
    // Due at 12:00:07, every 60 s; the scheduler was down until 12:10:30.
    const { slot, next } = currentAndNextSlot(secondsAfterT0(7), 60, secondsAfterT0(630));

    expect(slot.toISOString()).toBe("2026-01-01T12:10:07.000Z");
    expect(next.toISOString()).toBe("2026-01-01T12:11:07.000Z");
  });

  it("treats a slot that is due exactly now as current", () => {
    const { slot } = currentAndNextSlot(T0, 60, secondsAfterT0(60));

    expect(slot.toISOString()).toBe("2026-01-01T12:01:00.000Z");
  });
});

describe("scheduler.tick", () => {
  it("enqueues a due monitor and advances its schedule by one interval", async () => {
    const monitor = await createMonitor(db, userId, { intervalSeconds: 300 });
    const queue = recordingQueue();
    const scheduler = createScheduler({ db, enqueue: queue.enqueue, now: () => T0 });

    const claimed = await scheduler.tick();

    expect(claimed).toBe(1);
    expect(queue.jobs).toEqual([
      {
        id: checkJobId(monitor.id, T0),
        data: { monitorId: monitor.id, scheduledFor: "2026-01-01T12:00:00.000Z" },
      },
    ]);
    expect(await nextCheckAt(monitor.id)).toBe("2026-01-01T12:05:00.000Z");
  });

  it("leaves monitors that are not yet due, or paused, alone", async () => {
    const future = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(1) });
    const paused = await createMonitor(db, userId, { paused: true });
    const queue = recordingQueue();

    const claimed = await createScheduler({ db, enqueue: queue.enqueue, now: () => T0 }).tick();

    expect(claimed).toBe(0);
    expect(queue.jobs).toEqual([]);
    expect(await nextCheckAt(future.id)).toBe(secondsAfterT0(1).toISOString());
    expect(await nextCheckAt(paused.id)).toBe(T0.toISOString());
  });

  it("does not enqueue the same slot twice on consecutive ticks", async () => {
    await createMonitor(db, userId);
    const queue = recordingQueue();
    const scheduler = createScheduler({ db, enqueue: queue.enqueue, now: () => T0 });

    await scheduler.tick();
    await scheduler.tick();

    expect(queue.jobs).toHaveLength(1);
  });

  it("enqueues one check, not a backlog, after ten minutes of downtime", async () => {
    const monitor = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(7) });
    const queue = recordingQueue();
    const afterOutage = secondsAfterT0(630);

    await createScheduler({ db, enqueue: queue.enqueue, now: () => afterOutage }).tick();

    expect(queue.jobs.map((job) => job.data.scheduledFor)).toEqual(["2026-01-01T12:10:07.000Z"]);
    expect(await nextCheckAt(monitor.id)).toBe("2026-01-01T12:11:07.000Z");
  });

  it("takes at most one batch per tick, oldest first, and the rest on the next", async () => {
    const late = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(-30) });
    const later = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(-20) });
    const latest = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(-10) });
    const queue = recordingQueue();
    const scheduler = createScheduler({ db, enqueue: queue.enqueue, now: () => T0, batchSize: 2 });

    expect(await scheduler.tick()).toBe(2);
    expect(queue.jobs.map((job) => job.data.monitorId)).toEqual([late.id, later.id]);

    expect(await scheduler.tick()).toBe(1);
    expect(queue.jobs.map((job) => job.data.monitorId)).toEqual([late.id, later.id, latest.id]);
  });

  it("does not change updated_at, which belongs to user edits", async () => {
    const monitor = await createMonitor(db, userId);

    await createScheduler({ db, enqueue: recordingQueue().enqueue, now: () => T0 }).tick();
    const after = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });

    expect(after.updatedAt.toISOString()).toBe(monitor.updatedAt.toISOString());
  });
});

describe("concurrent schedulers", () => {
  it("claim different monitors, so every monitor is enqueued exactly once", async () => {
    const monitors = await Promise.all(Array.from({ length: 40 }, () => createMonitor(db, userId)));
    const claimedBy: Record<string, string[]> = { a: [], b: [], c: [] };

    // Each scheduler holds its transaction open while "enqueueing", which is
    // when the others run their own SELECT ... SKIP LOCKED.
    const slowScheduler = (name: string) =>
      createScheduler({
        db,
        now: () => T0,
        batchSize: 15,
        enqueue: async (jobs) => {
          claimedBy[name]?.push(...jobs.map((job) => job.data.monitorId));
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
      });
    const schedulers = ["a", "b", "c"].map(slowScheduler);

    // Keep ticking all three together until nothing is due.
    for (;;) {
      const claimed = await Promise.all(schedulers.map((scheduler) => scheduler.tick()));
      if (claimed.every((count) => count === 0)) break;
    }

    const everyClaim = Object.values(claimedBy).flat();
    expect(everyClaim).toHaveLength(monitors.length);
    expect(new Set(everyClaim)).toEqual(new Set(monitors.map((monitor) => monitor.id)));
    // More than one scheduler did real work: they ran side by side, not in turn.
    expect(Object.values(claimedBy).filter((claims) => claims.length > 0).length).toBeGreaterThan(
      1,
    );
  });
});

describe("a scheduler that is mid-transaction", () => {
  it("does not block another scheduler, which takes a different monitor straight away", async () => {
    // This is what SKIP LOCKED buys. With a plain FOR UPDATE the second
    // scheduler would queue up behind the first one's row lock, wait for it
    // to commit, then find that row no longer due and come back with nothing.
    const first = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(-20) });
    const second = await createMonitor(db, userId, { nextCheckAt: secondsAfterT0(-10) });
    let releaseSlow: () => void = () => undefined;
    let slowHasClaimed: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => (slowHasClaimed = resolve));

    const slow = createScheduler({
      db,
      now: () => T0,
      batchSize: 1,
      enqueue: () => {
        slowHasClaimed();
        return new Promise<void>((resolve) => (releaseSlow = resolve));
      },
    });
    const fastQueue = recordingQueue();
    const fast = createScheduler({ db, now: () => T0, batchSize: 1, enqueue: fastQueue.enqueue });

    const slowTick = slow.tick();
    await claimed; // the slow scheduler now holds a lock on the oldest monitor

    const fastClaimed = await fast.tick();

    // The fast scheduler finished while the slow one was still holding its
    // lock, and it took the OTHER monitor.
    expect(fastClaimed).toBe(1);
    expect(fastQueue.jobs.map((job) => job.data.monitorId)).toEqual([second.id]);

    releaseSlow();
    expect(await slowTick).toBe(1);
    expect(await nextCheckAt(first.id)).toBe(secondsAfterT0(40).toISOString());
  });
});

describe("failure between enqueue and commit", () => {
  it("leaves the monitor due when enqueueing fails, so the check is not lost", async () => {
    const monitor = await createMonitor(db, userId);
    const failing = createScheduler({
      db,
      now: () => T0,
      enqueue: () => Promise.reject(new Error("Redis is unavailable")),
    });

    await expect(failing.tick()).rejects.toThrow("Redis is unavailable");

    expect(await nextCheckAt(monitor.id)).toBe(T0.toISOString());
  });

  it("re-enqueues the SAME job ID after a crash that follows a successful enqueue", async () => {
    const monitor = await createMonitor(db, userId);
    const enqueued: string[] = [];

    // Simulates the process dying after the job reached Redis but before the
    // database commit: the job is recorded, then the transaction is aborted.
    const crashing = createScheduler({
      db,
      now: () => T0,
      enqueue: (jobs) => {
        enqueued.push(...jobs.map((job) => job.id));
        return Promise.reject(new Error("process killed before commit"));
      },
    });
    await expect(crashing.tick()).rejects.toThrow();

    // A fresh scheduler starts up a few seconds later.
    const recovered = createScheduler({
      db,
      now: () => secondsAfterT0(5),
      enqueue: (jobs) => {
        enqueued.push(...jobs.map((job) => job.id));
        return Promise.resolve();
      },
    });
    await recovered.tick();

    // Both attempts produced the identical ID, which is what lets the queue
    // and the database discard the duplicate.
    expect(enqueued).toEqual([checkJobId(monitor.id, T0), checkJobId(monitor.id, T0)]);
    expect(await nextCheckAt(monitor.id)).toBe("2026-01-01T12:01:00.000Z");
  });
});
