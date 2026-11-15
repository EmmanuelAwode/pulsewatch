import type { PrismaClient } from "@pulsewatch/database";
import { createCheckProcessor } from "./checks/processor.js";
import { createCheckQueue, createCheckWorker, redisConnection } from "./checks/queue.js";
import { createScheduler } from "./checks/scheduler.js";
import type { WorkerConfig } from "./config.js";
import type { Prober } from "./probe/prober.js";

/** The minimum a logger must offer. Pino satisfies it; tests pass a silent one. */
export interface Logger {
  info: (details: object, message: string) => void;
  warn: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
}

export interface RuntimeDependencies {
  config: Pick<WorkerConfig, "redisUrl" | "concurrency" | "schedulerTickMs" | "schedulerBatchSize">;
  db: PrismaClient;
  probe: Prober;
  logger: Logger;
  now?: () => Date;
  /** Overrides the queue name so that parallel tests cannot see each other's jobs. */
  queueName?: string;
}

export interface WorkerRuntime {
  /** Stops scheduling, lets in-flight checks finish, then closes connections. */
  stop: () => Promise<void>;
}

/** A timer that can be cut short, so shutdown does not wait out a full tick. */
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
 * Wires the scheduler, the queue and the check processor together and starts
 * them. Like `buildApp` in the API, this takes everything it needs as
 * arguments, so tests run the real thing against a test database and Redis
 * with a fake prober.
 *
 * One process runs both roles for simplicity. They scale independently if
 * needed: the scheduler is safe to run in several processes (SKIP LOCKED),
 * and so are the processors (competing consumers on one queue).
 */
export function startWorkerRuntime(deps: RuntimeDependencies): WorkerRuntime {
  const { config, db, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const queueSettings = {
    connection: redisConnection(config.redisUrl),
    ...(deps.queueName ? { name: deps.queueName } : {}),
  };

  const queue = createCheckQueue(queueSettings);
  const worker = createCheckWorker({
    ...queueSettings,
    processor: createCheckProcessor({ db, probe: deps.probe, now }),
    concurrency: config.concurrency,
  });
  const scheduler = createScheduler({
    db,
    enqueue: queue.enqueue,
    now,
    batchSize: config.schedulerBatchSize,
  });

  // A job that throws is retried by BullMQ. It is only reported here once
  // every attempt has been used up, which means a check was genuinely lost.
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

  async function runScheduler(): Promise<void> {
    while (!stopping.signal.aborted) {
      try {
        const claimed = await scheduler.tick();
        // A full batch means more monitors are probably due: go again at once.
        if (claimed >= config.schedulerBatchSize) continue;
      } catch (error) {
        // Postgres or Redis is unavailable. Nothing was lost (the transaction
        // rolled back), so log it and try again on the next tick.
        logger.error({ err: error }, "scheduler tick failed");
      }
      await sleep(config.schedulerTickMs, stopping.signal);
    }
  }
  const schedulerLoop = runScheduler();

  return {
    async stop() {
      stopping.abort();
      await schedulerLoop;
      // Waits for checks that are already running to finish and store their
      // results. Jobs still waiting stay in Redis for the next worker.
      await worker.close();
      await queue.close();
    },
  };
}
