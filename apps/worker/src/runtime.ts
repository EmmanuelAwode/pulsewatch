import type { PrismaClient } from "@pulsewatch/database";
import { DEFAULT_RETENTION_DAYS, EVENTS_CHANNEL, type EventEnvelope } from "@pulsewatch/shared";
import { Redis } from "ioredis";
import { createCheckProcessor, type RecordedCheck } from "./checks/processor.js";
import { createCheckQueue, createCheckWorker, redisConnection } from "./checks/queue.js";
import { createScheduler } from "./checks/scheduler.js";
import type { WorkerConfig } from "./config.js";
import { runRetention } from "./maintenance/retention.js";
import type { WorkerMetrics } from "./metrics.js";
import { createLogMailer, type Mailer } from "./notifications/mailer.js";
import { createNotificationSender } from "./notifications/sender.js";
import type { Prober } from "./probe/prober.js";

/** The minimum a logger must offer. Pino satisfies it; tests pass a silent one. */
export interface Logger {
  info: (details: object, message: string) => void;
  warn: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
}

type RequiredSettings = "redisUrl" | "concurrency" | "schedulerTickMs" | "schedulerBatchSize";
type OptionalSettings = "notificationSweepMs" | "retentionDays";

export interface RuntimeDependencies {
  config: Pick<WorkerConfig, RequiredSettings> & Partial<Pick<WorkerConfig, OptionalSettings>>;
  db: PrismaClient;
  probe: Prober;
  logger: Logger;
  /** Delivers alert emails. Defaults to writing them to the log. */
  mailer?: Mailer;
  /** Created by main.ts; tests can leave it out. */
  createMetrics?: (queueCounts: () => Promise<Record<string, number>>) => WorkerMetrics;
  now?: () => Date;
  /** Overrides the queue name so that parallel tests cannot see each other's jobs. */
  queueName?: string;
}

export interface WorkerRuntime {
  /** Stops scheduling, lets in-flight checks finish, then closes connections. */
  stop: () => Promise<void>;
  metrics: WorkerMetrics | undefined;
}

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** A timer that can be cut short, so shutdown does not wait out a full interval. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Wires the background work together and starts it:
 *
 *   scheduler loop        due monitors -> check jobs           (every second)
 *   check workers         check jobs -> results and incidents  (on demand)
 *   notification loop     outbox -> emails                     (every 15 s)
 *   retention loop        delete old results and sessions      (hourly)
 *
 * Like `buildApp` in the API, it takes everything it needs as arguments, so
 * tests run the real thing against a test database and Redis with a fake
 * prober and mailer. Every loop is safe to run in several processes at once.
 */
export function startWorkerRuntime(deps: RuntimeDependencies): WorkerRuntime {
  const { config, db, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const mailer = deps.mailer ?? createLogMailer(logger);
  const queueSettings = {
    connection: redisConnection(config.redisUrl),
    ...(deps.queueName ? { name: deps.queueName } : {}),
  };

  const queue = createCheckQueue(queueSettings);
  const metrics = deps.createMetrics?.(() =>
    queue.raw.getJobCounts("waiting", "active", "delayed", "failed"),
  );
  // A dedicated connection for publishing live events.
  const publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  publisher.on("error", (error) => {
    logger.warn({ err: error }, "event publisher connection error");
  });

  async function onRecorded(record: RecordedCheck): Promise<void> {
    metrics?.recordCheck(record);
    try {
      for (const event of record.events) {
        const envelope: EventEnvelope = { userId: record.userId, event };
        await publisher.publish(EVENTS_CHANNEL, JSON.stringify(envelope));
      }
    } catch (error) {
      // Live events are a convenience (ADR-006). The result is already
      // committed, so a failed publish is logged and nothing else happens.
      logger.warn({ err: error }, "could not publish live events");
    }
  }

  const worker = createCheckWorker({
    ...queueSettings,
    processor: createCheckProcessor({ db, probe: deps.probe, now, onRecorded }),
    concurrency: config.concurrency,
  });
  const scheduler = createScheduler({
    db,
    enqueue: async (jobs) => {
      await queue.enqueue(jobs);
      metrics?.recordEnqueued(jobs.length);
    },
    now,
    batchSize: config.schedulerBatchSize,
  });
  const sender = createNotificationSender({ db, mailer, now });

  // A job that throws is retried by BullMQ. It is only reported as an error
  // once every attempt has been used up, which means a check was lost.
  worker.on("failed", (job, error) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      logger.error({ jobId: job.id, err: error }, "check job failed permanently");
    } else {
      logger.warn({ jobId: job?.id, err: error }, "check job failed, will retry");
    }
  });
  worker.on("error", (error) => {
    logger.error({ err: error }, "worker error");
  });

  const stopping = new AbortController();

  /** Runs `step` repeatedly. An error is logged and the loop carries on. */
  async function loop(name: string, intervalMs: number, step: () => Promise<boolean>) {
    while (!stopping.signal.aborted) {
      let again = false;
      try {
        again = await step();
      } catch (error) {
        // Usually Postgres or Redis is briefly unavailable. Each step is
        // transactional, so nothing was half-done; try again next interval.
        logger.error({ err: error }, `${name} failed`);
      }
      if (!again) await sleep(intervalMs, stopping.signal);
    }
  }

  const loops = [
    // A full batch means more monitors are probably due: go again at once.
    loop("scheduler tick", config.schedulerTickMs, async () => {
      return (await scheduler.tick()) >= config.schedulerBatchSize;
    }),
    loop("notification sweep", config.notificationSweepMs ?? 15_000, async () => {
      const result = await sender.sweep();
      metrics?.recordNotifications("sent", result.sent);
      metrics?.recordNotifications("retrying", result.retrying);
      metrics?.recordNotifications("failed", result.failed);
      return false;
    }),
    loop("retention", RETENTION_INTERVAL_MS, async () => {
      const removed = await runRetention({
        db,
        now,
        retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS,
      });
      if (removed.checkResults > 0 || removed.refreshTokens > 0) {
        logger.info(removed, "retention removed old rows");
      }
      return false;
    }),
  ];

  return {
    metrics,
    async stop() {
      stopping.abort();
      await Promise.all(loops);
      // Waits for checks that are already running to finish and store their
      // results. Jobs still waiting stay in Redis for the next worker.
      await worker.close();
      await queue.close();
      publisher.disconnect();
    },
  };
}
