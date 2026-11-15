import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import { CHECK_QUEUE, type CheckJob, type CheckJobData } from "./job.js";
import type { CheckOutcome, CheckProcessor } from "./processor.js";

/**
 * BullMQ connection settings for a Redis URL.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ workers: they use
 * blocking commands that wait for the next job, and a per-request retry
 * limit would make those fail during a brief Redis outage instead of
 * reconnecting and carrying on.
 */
export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

/**
 * These options govern retries of the JOB, i.e. of our own machinery. They
 * never cause an endpoint to be re-checked because it was down: a failed
 * check completes its job successfully (see processor.ts).
 */
const JOB_OPTIONS: JobsOptions = {
  // Up to 5 attempts, waiting 1 s, 2 s, 4 s, 8 s between them. Backing off
  // gives a struggling database room to recover instead of adding load.
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  // Finished jobs are deleted after a while so Redis memory stays bounded.
  // Completed jobs are kept for an hour, which also keeps their IDs around
  // to reject duplicates during that window.
  removeOnComplete: { age: 3_600, count: 10_000 },
  removeOnFail: { age: 24 * 3_600 },
};

export interface CheckQueue {
  /** Adds jobs. A job whose ID is already in the queue is ignored by BullMQ. */
  enqueue: (jobs: CheckJob[]) => Promise<void>;
  close: () => Promise<void>;
  /** The underlying BullMQ queue, for inspection in tests and metrics. */
  raw: Queue<CheckJobData, CheckOutcome>;
}

export interface QueueSettings {
  connection: ConnectionOptions;
  /** Overrides the queue name. Tests use a unique name each so they cannot collide. */
  name?: string;
}

export function createCheckQueue(settings: QueueSettings): CheckQueue {
  const queue = new Queue<CheckJobData, CheckOutcome>(settings.name ?? CHECK_QUEUE, {
    connection: settings.connection,
    defaultJobOptions: JOB_OPTIONS,
  });

  return {
    async enqueue(jobs) {
      await queue.addBulk(
        jobs.map((job) => ({ name: "check", data: job.data, opts: { jobId: job.id } })),
      );
    },
    close: () => queue.close(),
    raw: queue,
  };
}

export interface WorkerSettings extends QueueSettings {
  processor: CheckProcessor;
  /**
   * How many checks run at once in this process. Checks are I/O-bound, so
   * this is a limit on open sockets and database connections, not on CPU.
   * It is also the back-pressure mechanism: when checks are slow, jobs wait
   * in Redis instead of piling up in this process's memory.
   */
  concurrency: number;
}

export function createCheckWorker(settings: WorkerSettings): Worker<CheckJobData, CheckOutcome> {
  return new Worker<CheckJobData, CheckOutcome>(
    settings.name ?? CHECK_QUEUE,
    (job) => settings.processor(job.data),
    { connection: settings.connection, concurrency: settings.concurrency },
  );
}
