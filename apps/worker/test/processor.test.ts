import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createCheckProcessor } from "../src/checks/processor.js";
import type { Prober, ProbeResult } from "../src/probe/prober.js";
import { createMonitor, createUser, resetDatabase, secondsAfterT0, T0 } from "./helpers.js";

/**
 * The check processor against a real PostgreSQL, with the network replaced by
 * a fake prober that returns whatever result the test asks for.
 */

const UP: ProbeResult = { success: true, statusCode: 200, responseTimeMs: 123 };
const DOWN: ProbeResult = {
  success: false,
  statusCode: 503,
  responseTimeMs: 45,
  errorType: "HTTP_STATUS",
  errorMessage: "The endpoint responded with HTTP 503.",
};
const TIMED_OUT: ProbeResult = {
  success: false,
  statusCode: null,
  responseTimeMs: null,
  errorType: "TIMEOUT",
  errorMessage: "No response within 10000 ms.",
};

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

function proberReturning(...results: ProbeResult[]) {
  let call = 0;
  return vi.fn<Prober>(() => {
    const result = results[Math.min(call, results.length - 1)] ?? UP;
    call += 1;
    return Promise.resolve(result);
  });
}

function jobFor(monitorId: string, slot: Date = T0) {
  return { monitorId, scheduledFor: slot.toISOString() };
}

async function state(monitorId: string) {
  const monitor = await db.monitor.findUniqueOrThrow({ where: { id: monitorId } });
  const results = await db.checkResult.findMany({
    where: { monitorId },
    orderBy: { scheduledFor: "asc" },
  });
  return { monitor, results };
}

describe("recording a check", () => {
  it("stores a successful check and updates the monitor", async () => {
    const monitor = await createMonitor(db, userId);
    const probe = proberReturning(UP);
    const process = createCheckProcessor({ db, probe, now: () => secondsAfterT0(2) });

    const outcome = await process(jobFor(monitor.id));
    const { monitor: after, results } = await state(monitor.id);

    expect(outcome).toBe("recorded");
    expect(probe).toHaveBeenCalledExactlyOnceWith({
      url: monitor.url,
      method: "GET",
      timeoutMs: 10_000,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      success: true,
      statusCode: 200,
      responseTimeMs: 123,
      errorType: null,
      errorMessage: null,
    });
    // scheduledFor is the slot; checkedAt is when the request actually began.
    expect(results[0]?.scheduledFor.toISOString()).toBe(T0.toISOString());
    expect(results[0]?.checkedAt.toISOString()).toBe(secondsAfterT0(2).toISOString());
    expect(after).toMatchObject({ consecutiveSuccesses: 1, consecutiveFailures: 0 });
    expect(after.lastCheckedAt?.toISOString()).toBe(secondsAfterT0(2).toISOString());
  });

  it.each([
    ["an HTTP error", DOWN, "HTTP_STATUS"],
    ["a timeout", TIMED_OUT, "TIMEOUT"],
  ])(
    "stores %s as a failed check and completes the job normally",
    async (_label, result, errorType) => {
      const monitor = await createMonitor(db, userId);
      const process = createCheckProcessor({ db, probe: proberReturning(result), now: () => T0 });

      // The important part: this resolves. A down endpoint is not a failed job.
      await expect(process(jobFor(monitor.id))).resolves.toBe("recorded");

      const { monitor: after, results } = await state(monitor.id);
      expect(results[0]).toMatchObject({
        success: false,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        errorType,
      });
      expect(after).toMatchObject({ consecutiveFailures: 1, consecutiveSuccesses: 0 });
    },
  );

  it("counts consecutive results and resets the opposite counter", async () => {
    const monitor = await createMonitor(db, userId);
    const process = createCheckProcessor({
      db,
      probe: proberReturning(DOWN, DOWN, UP),
      now: () => T0,
    });

    await process(jobFor(monitor.id, secondsAfterT0(0)));
    await process(jobFor(monitor.id, secondsAfterT0(60)));
    expect((await state(monitor.id)).monitor).toMatchObject({
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
    });

    await process(jobFor(monitor.id, secondsAfterT0(120)));
    expect((await state(monitor.id)).monitor).toMatchObject({
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
    });
  });
});

describe("idempotency", () => {
  it("does nothing when the same job is processed again", async () => {
    const monitor = await createMonitor(db, userId);
    const probe = proberReturning(DOWN);
    const process = createCheckProcessor({ db, probe, now: () => T0 });

    expect(await process(jobFor(monitor.id))).toBe("recorded");
    expect(await process(jobFor(monitor.id))).toBe("duplicate");
    expect(await process(jobFor(monitor.id))).toBe("duplicate");

    const { monitor: after, results } = await state(monitor.id);
    expect(results).toHaveLength(1);
    // Three deliveries, one failure counted: retries cannot push a monitor
    // towards the incident threshold.
    expect(after.consecutiveFailures).toBe(1);
    // And the endpoint was only contacted once.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("stores one result when the same job is delivered five times at once", async () => {
    const monitor = await createMonitor(db, userId);
    const process = createCheckProcessor({ db, probe: proberReturning(DOWN), now: () => T0 });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => process(jobFor(monitor.id))),
    );

    const { monitor: after, results } = await state(monitor.id);
    expect(outcomes.filter((outcome) => outcome === "recorded")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "duplicate")).toHaveLength(4);
    expect(results).toHaveLength(1);
    expect(after.consecutiveFailures).toBe(1);
  });

  it("counts every slot once when many different slots finish at the same time", async () => {
    const monitor = await createMonitor(db, userId);
    const process = createCheckProcessor({ db, probe: proberReturning(DOWN), now: () => T0 });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        process(jobFor(monitor.id, secondsAfterT0(index * 60))),
      ),
    );

    const { results } = await state(monitor.id);
    expect(results).toHaveLength(8);
  });
});

describe("out-of-order completion", () => {
  it("keeps a late result in the history without rewinding the current state", async () => {
    const monitor = await createMonitor(db, userId);
    const process = createCheckProcessor({ db, probe: proberReturning(UP, DOWN), now: () => T0 });

    // The 12:01 check (success) finishes first...
    await process(jobFor(monitor.id, secondsAfterT0(60)));
    // ...then the slower 12:00 check (failure) finally completes.
    await process(jobFor(monitor.id, secondsAfterT0(0)));

    const { monitor: after, results } = await state(monitor.id);
    expect(results.map((result) => result.success)).toEqual([false, true]);
    // The newest information is still "up": the old failure did not undo it.
    expect(after).toMatchObject({ consecutiveSuccesses: 1, consecutiveFailures: 0 });
  });
});

describe("two slots for one monitor finishing at the same moment", () => {
  it("always leaves the monitor reflecting the newer result", async () => {
    // An older failed check and a newer successful one are stored at the same
    // time. Each transaction asks "is there a newer result than mine?" and
    // then updates the counters. Without the row lock those two steps can
    // interleave, and the older failure can be the last write. The race is a
    // matter of timing, so it is attempted many times.
    const older = createCheckProcessor({ db, probe: proberReturning(DOWN), now: () => T0 });
    const newer = createCheckProcessor({ db, probe: proberReturning(UP), now: () => T0 });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const monitor = await createMonitor(db, userId);

      await Promise.all([
        older(jobFor(monitor.id, secondsAfterT0(0))),
        newer(jobFor(monitor.id, secondsAfterT0(60))),
      ]);

      const { monitor: after, results } = await state(monitor.id);
      expect(results).toHaveLength(2);
      expect({
        attempt,
        consecutiveSuccesses: after.consecutiveSuccesses,
        consecutiveFailures: after.consecutiveFailures,
      }).toEqual({ attempt, consecutiveSuccesses: 1, consecutiveFailures: 0 });
    }
  });
});

describe("monitors that changed after the job was queued", () => {
  it("skips a deleted monitor without contacting anything", async () => {
    const monitor = await createMonitor(db, userId);
    await db.monitor.delete({ where: { id: monitor.id } });
    const probe = proberReturning(UP);

    const outcome = await createCheckProcessor({ db, probe, now: () => T0 })(jobFor(monitor.id));

    expect(outcome).toBe("skipped");
    expect(probe).not.toHaveBeenCalled();
  });

  it("skips a paused monitor without contacting anything", async () => {
    const monitor = await createMonitor(db, userId, { paused: true });
    const probe = proberReturning(UP);

    const outcome = await createCheckProcessor({ db, probe, now: () => T0 })(jobFor(monitor.id));

    expect(outcome).toBe("skipped");
    expect(probe).not.toHaveBeenCalled();
    expect((await state(monitor.id)).results).toHaveLength(0);
  });

  it("stores nothing if the monitor is deleted while the check is in flight", async () => {
    const monitor = await createMonitor(db, userId);
    const probe: Prober = async () => {
      await db.monitor.delete({ where: { id: monitor.id } });
      return UP;
    };

    const outcome = await createCheckProcessor({ db, probe, now: () => T0 })(jobFor(monitor.id));

    expect(outcome).toBe("skipped");
    expect(await db.checkResult.count()).toBe(0);
  });
});

describe("infrastructure failure", () => {
  it("throws, so the queue retries, when the database cannot be reached", async () => {
    const monitor = await createMonitor(db, userId);
    // Nothing listens on port 1.
    const deadDb = createDatabaseClient({
      connectionString: "postgresql://user:pass@127.0.0.1:1/none",
    });
    const process = createCheckProcessor({ db: deadDb, probe: proberReturning(UP), now: () => T0 });

    try {
      await expect(process(jobFor(monitor.id))).rejects.toThrow();
    } finally {
      await deadDb.$disconnect();
    }
    expect((await state(monitor.id)).results).toHaveLength(0);
  });

  it("throws when the prober itself throws, since that is a bug and not a result", async () => {
    const monitor = await createMonitor(db, userId);
    const broken: Prober = () => Promise.reject(new Error("unexpected"));

    await expect(
      createCheckProcessor({ db, probe: broken, now: () => T0 })(jobFor(monitor.id)),
    ).rejects.toThrow("unexpected");
    expect((await state(monitor.id)).results).toHaveLength(0);
  });
});
