import type { PrismaClient } from "@pulsewatch/database";
import type { Prober } from "../probe/prober.js";
import type { CheckJobData } from "./job.js";

export interface CheckProcessorOptions {
  db: PrismaClient;
  probe: Prober;
  now: () => Date;
}

/**
 * What happened to a job. Every one of these is a SUCCESSFUL job as far as
 * the queue is concerned, including "recorded a failed check".
 */
export type CheckOutcome =
  /** A new result was stored (the check itself may have passed or failed). */
  | "recorded"
  /** This slot already has a result: a retry or duplicate delivery. Nothing changed. */
  | "duplicate"
  /** The monitor was deleted or paused after the job was queued. */
  | "skipped";

export type CheckProcessor = (job: CheckJobData) => Promise<CheckOutcome>;

/**
 * Processes one check job: probe the endpoint, store the result, update the
 * monitor's counters.
 *
 * Two different things can "fail" here and they are handled differently
 * (ADR-003):
 *
 *   The CHECK fails (timeout, 503, bad certificate). That is a valid
 *   measurement. It is stored as a failed result and this function returns
 *   normally, so the queue marks the job complete and never retries it.
 *
 *   The JOB fails (database unreachable, a bug). Nothing could be stored, so
 *   this function throws and the queue retries with backoff.
 *
 * Because a retried job may run after an earlier attempt already stored its
 * result, storing must be idempotent: one slot, one row, one counter update.
 */
export function createCheckProcessor(options: CheckProcessorOptions): CheckProcessor {
  const { db, probe, now } = options;

  return async function processCheck(job) {
    const scheduledFor = new Date(job.scheduledFor);

    const monitor = await db.monitor.findUnique({ where: { id: job.monitorId } });
    if (!monitor || monitor.paused) return "skipped";

    // Fast path for retries: if an earlier attempt already stored this slot,
    // do not contact the endpoint again. (The unique constraint below is what
    // actually guarantees correctness; this only avoids a wasted request.)
    const existing = await db.checkResult.findUnique({
      where: { monitorId_scheduledFor: { monitorId: monitor.id, scheduledFor } },
      select: { id: true },
    });
    if (existing) return "duplicate";

    // The network request happens OUTSIDE any transaction. It can take up to
    // 30 seconds, and holding a database transaction (and a row lock) open
    // for that long would exhaust the connection pool under load.
    const checkedAt = now();
    const result = await probe({
      url: monitor.url,
      method: monitor.method,
      timeoutMs: monitor.timeoutMs,
    });

    return db.$transaction(async (tx) => {
      // Lock the monitor row. If two results for the same monitor are being
      // stored at once, the second waits here, so the read-modify-write on
      // the counters below cannot interleave (ADR-007).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM monitors WHERE id = ${monitor.id}::uuid FOR UPDATE`;
      if (locked.length === 0) return "skipped"; // deleted while we were probing

      // INSERT ... ON CONFLICT DO NOTHING on (monitor_id, scheduled_for).
      // `count` says whether this attempt is the one that stored the slot.
      const inserted = await tx.checkResult.createMany({
        data: [
          {
            monitorId: monitor.id,
            scheduledFor,
            checkedAt,
            success: result.success,
            statusCode: result.statusCode,
            responseTimeMs: result.responseTimeMs,
            errorType: result.success ? null : result.errorType,
            errorMessage: result.success ? null : result.errorMessage,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return "duplicate";

      // Jobs can finish out of order (a slow check for 12:00 may complete
      // after the check for 12:01). A late result is kept in the history but
      // must not overwrite the monitor's current state with older news.
      const newer = await tx.checkResult.findFirst({
        where: { monitorId: monitor.id, scheduledFor: { gt: scheduledFor } },
        select: { id: true },
      });
      if (!newer) {
        await tx.monitor.update({
          where: { id: monitor.id },
          data: result.success
            ? {
                consecutiveSuccesses: { increment: 1 },
                consecutiveFailures: 0,
                lastCheckedAt: checkedAt,
              }
            : {
                consecutiveFailures: { increment: 1 },
                consecutiveSuccesses: 0,
                lastCheckedAt: checkedAt,
              },
        });
      }
      return "recorded";
    });
  };
}
