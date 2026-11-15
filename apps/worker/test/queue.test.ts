import { randomUUID } from "node:crypto";
import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import { buildCheckJob } from "../src/checks/job.js";
import { createCheckProcessor } from "../src/checks/processor.js";
import { createCheckQueue, createCheckWorker, redisConnection } from "../src/checks/queue.js";
import type { Prober, ProbeResult } from "../src/probe/prober.js";
import { startWorkerRuntime, type WorkerRuntime } from "../src/runtime.js";
import { createMonitor, createUser, resetDatabase, silentLogger, T0, waitFor } from "./helpers.js";

/**
 * The pieces wired together through a real Redis and a real PostgreSQL:
 * scheduler -> BullMQ -> processor -> database. Only the outbound HTTP
 * request is faked. Each test uses its own queue name.
 */

const UP: ProbeResult = { success: true, statusCode: 200, responseTimeMs: 50 };

let db: PrismaClient;
let userId: string;
let queueName: string;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(() => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(db);
  userId = await createUser(db);
  queueName = `checks-test-${randomUUID()}`;
});

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function settings() {
  return { connection: redisConnection(inject("redisUrl")), name: queueName };
}

describe("queue and worker", () => {
  it("delivers an enqueued job to the processor, which stores the result", async () => {
    const monitor = await createMonitor(db, userId);
    const queue = createCheckQueue(settings());
    const worker = createCheckWorker({
      ...settings(),
      concurrency: 5,
      processor: createCheckProcessor({ db, probe: () => Promise.resolve(UP), now: () => T0 }),
    });
    cleanup.push(() => worker.close(), queue.close);

    await queue.enqueue([buildCheckJob(monitor.id, T0)]);

    await waitFor(() => db.checkResult.findFirst({ where: { monitorId: monitor.id } }));
    expect(await db.checkResult.count()).toBe(1);
  });

  it("ignores a second job with the same ID", async () => {
    const monitor = await createMonitor(db, userId);
    const queue = createCheckQueue(settings());
    cleanup.push(queue.close);
    const job = buildCheckJob(monitor.id, T0);

    await queue.enqueue([job]);
    await queue.enqueue([job]);
    await queue.enqueue([job, job]);

    expect(await queue.raw.getJobCountByTypes("waiting", "active", "delayed")).toBe(1);
  });

  it("retries a job that failed, and still ends with exactly one result", async () => {
    const monitor = await createMonitor(db, userId);
    const realProcessor = createCheckProcessor({
      db,
      probe: () => Promise.resolve(UP),
      now: () => T0,
    });
    // The first two attempts fail as if the database had been unreachable.
    const processor = vi
      .fn(realProcessor)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockRejectedValueOnce(new Error("database unavailable"));

    const queue = createCheckQueue(settings());
    const worker = createCheckWorker({ ...settings(), concurrency: 1, processor });
    cleanup.push(() => worker.close(), queue.close);

    // Same attempts as production, but without the exponential wait.
    await queue.raw.add("check", buildCheckJob(monitor.id, T0).data, {
      jobId: buildCheckJob(monitor.id, T0).id,
      attempts: 5,
      backoff: { type: "fixed", delay: 20 },
    });

    await waitFor(() => db.checkResult.findFirst({ where: { monitorId: monitor.id } }));
    expect(processor).toHaveBeenCalledTimes(3);
    expect(await db.checkResult.count()).toBe(1);
    const after = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });
    expect(after.consecutiveSuccesses).toBe(1);
  });

  it("stores one result when a job is retried AFTER its first attempt already saved", async () => {
    // The worst case for idempotency: the result was committed, then the
    // worker died before telling Redis, so the job is delivered again.
    const monitor = await createMonitor(db, userId);
    const probe = vi.fn<Prober>(() =>
      Promise.resolve({
        success: false,
        statusCode: 500,
        responseTimeMs: 10,
        errorType: "HTTP_STATUS",
        errorMessage: "The endpoint responded with HTTP 500.",
      }),
    );
    const realProcessor = createCheckProcessor({ db, probe, now: () => T0 });
    let attempts = 0;
    const processor = vi.fn(async (data: Parameters<typeof realProcessor>[0]) => {
      attempts += 1;
      const outcome = await realProcessor(data);
      if (attempts === 1) throw new Error("worker crashed after commit");
      return outcome;
    });

    const queue = createCheckQueue(settings());
    const worker = createCheckWorker({ ...settings(), concurrency: 1, processor });
    cleanup.push(() => worker.close(), queue.close);
    const job = buildCheckJob(monitor.id, T0);
    await queue.raw.add("check", job.data, {
      jobId: job.id,
      attempts: 3,
      backoff: { type: "fixed", delay: 20 },
    });

    await waitFor(async () => attempts >= 2 && (await queue.raw.getCompletedCount()) === 1);

    expect(await db.checkResult.count()).toBe(1);
    const after = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });
    expect(after.consecutiveFailures).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("worker runtime, end to end", () => {
  let runtime: WorkerRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  function start(probe: Prober, now: () => Date) {
    runtime = startWorkerRuntime({
      config: {
        redisUrl: inject("redisUrl"),
        concurrency: 10,
        schedulerTickMs: 50,
        schedulerBatchSize: 100,
      },
      db,
      probe,
      logger: silentLogger,
      now,
      queueName,
    });
  }

  it("checks every due monitor once and schedules the next check", async () => {
    const monitors = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createMonitor(db, userId, { url: `https://api.example.com/${index}` }),
      ),
    );
    const probed: string[] = [];

    start(
      (target) => {
        probed.push(target.url);
        return Promise.resolve(UP);
      },
      () => T0,
    );

    await waitFor(async () => (await db.checkResult.count()) === monitors.length);
    // Give the scheduler several more ticks: nothing further should happen,
    // because the clock is fixed and no monitor is due again.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await db.checkResult.count()).toBe(monitors.length);
    expect(probed.sort()).toEqual(monitors.map((monitor) => monitor.url).sort());
    const rescheduled = await db.monitor.findMany();
    expect(rescheduled.every((monitor) => monitor.nextCheckAt > T0)).toBe(true);
    expect(rescheduled.every((monitor) => monitor.consecutiveSuccesses === 1)).toBe(true);
  });

  it("checks a monitor again each time its interval passes", async () => {
    const monitor = await createMonitor(db, userId, { intervalSeconds: 60 });
    let currentTime = T0;
    start(
      () => Promise.resolve(UP),
      () => currentTime,
    );

    await waitFor(async () => (await db.checkResult.count()) === 1);
    currentTime = new Date(T0.getTime() + 60_000);
    await waitFor(async () => (await db.checkResult.count()) === 2);
    currentTime = new Date(T0.getTime() + 120_000);
    await waitFor(async () => (await db.checkResult.count()) === 3);

    const slots = await db.checkResult.findMany({
      where: { monitorId: monitor.id },
      orderBy: { scheduledFor: "asc" },
    });
    expect(slots.map((result) => result.scheduledFor.toISOString())).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T12:01:00.000Z",
      "2026-01-01T12:02:00.000Z",
    ]);
  });

  it("finishes a check that is in flight when asked to stop", async () => {
    const monitor = await createMonitor(db, userId);
    let release: (result: ProbeResult) => void = () => undefined;
    let started = false;
    start(
      () =>
        new Promise<ProbeResult>((resolve) => {
          started = true;
          release = resolve;
        }),
      () => T0,
    );
    await waitFor(() => Promise.resolve(started));

    // Ask the worker to stop while the check is still waiting on the network.
    const stopping = runtime?.stop();
    runtime = undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await db.checkResult.count()).toBe(0);

    release(UP);
    await stopping;

    // stop() waited for the check, and its result was saved, not dropped.
    expect(await db.checkResult.count({ where: { monitorId: monitor.id } })).toBe(1);
  });
});
