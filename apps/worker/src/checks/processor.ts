import type { Prisma, PrismaClient } from "@pulsewatch/database";
import type { LiveEvent } from "@pulsewatch/shared";
import type { Prober, ProbeResult } from "../probe/prober.js";
import type { CheckJobData } from "./job.js";
import { applyCheck, type MonitorStatus } from "./state-machine.js";

/** Everything that happened when one check was stored. Handed to `onRecorded` after commit. */
export interface RecordedCheck {
  userId: string;
  monitorId: string;
  scheduledFor: Date;
  checkedAt: Date;
  result: ProbeResult;
  /** Live events for the dashboard, in the order they happened. */
  events: LiveEvent[];
}

export interface CheckProcessorOptions {
  db: PrismaClient;
  probe: Prober;
  now: () => Date;
  /**
   * Called after the transaction commits, never before, so anything it does
   * (publishing live events, recording metrics) only ever describes data that
   * is really in the database. It must not throw.
   */
  onRecorded?: (record: RecordedCheck) => Promise<void>;
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

type Tx = Prisma.TransactionClient;

interface LockedMonitor {
  id: string;
  user_id: string;
  status: MonitorStatus;
  consecutive_failures: number;
  consecutive_successes: number;
  failure_threshold: number;
  recovery_threshold: number;
}

/**
 * The slot where the current streak of failures (or successes) began, up to
 * and including `slot`: the earliest result after the most recent result of
 * the opposite kind.
 *
 * An incident's start is back-dated to the first failure of the streak, not
 * the check that crossed the threshold, so its duration reflects when the
 * outage really began. Both lookups use the (monitor_id, scheduled_for) index.
 */
async function streakStart(tx: Tx, monitorId: string, slot: Date, success: boolean): Promise<Date> {
  const rows = await tx.$queryRaw<{ started: Date | null }[]>`
    SELECT min(scheduled_for) AS started
    FROM check_results
    WHERE monitor_id = ${monitorId}::uuid
      AND scheduled_for <= ${slot}
      AND success = ${success}
      AND scheduled_for > coalesce(
        (SELECT max(scheduled_for) FROM check_results
          WHERE monitor_id = ${monitorId}::uuid
            AND scheduled_for <= ${slot}
            AND success = ${!success}),
        '-infinity'::timestamptz)`;
  return rows[0]?.started ?? slot;
}

/**
 * Transactional outbox (ADR-008): the delivery row is written in the same
 * transaction as the incident change, so an alert can neither be lost nor
 * sent for an incident that was rolled back. The sender delivers it later.
 */
async function queueNotification(
  tx: Tx,
  userId: string,
  incidentId: string,
  event: "INCIDENT_OPENED" | "INCIDENT_RESOLVED",
): Promise<void> {
  const settings = await tx.notificationSettings.findUnique({ where: { userId } });
  if (!settings?.emailEnabled) return;
  if (event === "INCIDENT_OPENED" && !settings.notifyOnDown) return;
  if (event === "INCIDENT_RESOLVED" && !settings.notifyOnRecovery) return;

  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return;

  // The unique key (incident, event, channel) makes a repeat a no-op.
  await tx.notificationDelivery.createMany({
    data: [{ incidentId, event, channel: "EMAIL", recipient: user.email }],
    skipDuplicates: true,
  });
}

/**
 * Processes one check job: probe the endpoint, store the result, move the
 * monitor through its state machine, and open or resolve an incident.
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
 * result, storing must be idempotent: one slot, one row, one state change.
 */
export function createCheckProcessor(options: CheckProcessorOptions): CheckProcessor {
  const { db, probe, now, onRecorded } = options;

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

    const record = await db.$transaction(async (tx): Promise<RecordedCheck | CheckOutcome> => {
      // Lock the monitor row and read its CURRENT state. If two results for
      // the same monitor are being stored at once, the second waits here, so
      // the read-decide-write below can never interleave (ADR-007).
      const [locked] = await tx.$queryRaw<LockedMonitor[]>`
        SELECT id, user_id, status, consecutive_failures, consecutive_successes,
               failure_threshold, recovery_threshold
        FROM monitors WHERE id = ${monitor.id}::uuid FOR UPDATE`;
      if (!locked) return "skipped"; // deleted while we were probing

      // INSERT ... ON CONFLICT DO NOTHING on (monitor_id, scheduled_for).
      // `count` says whether this attempt is the one that stored the slot.
      const inserted = await tx.checkResult.createMany({
        data: [
          {
            monitorId: locked.id,
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

      const events: LiveEvent[] = [
        {
          type: "check.completed",
          monitorId: locked.id,
          success: result.success,
          scheduledFor: scheduledFor.toISOString(),
        },
      ];
      const recorded = {
        userId: locked.user_id,
        monitorId: locked.id,
        scheduledFor,
        checkedAt,
        result,
        events,
      };

      // Jobs can finish out of order (a slow check for 12:00 may complete
      // after the check for 12:01). A late result is kept in the history but
      // must not overwrite the monitor's state with older news.
      const newer = await tx.checkResult.findFirst({
        where: { monitorId: locked.id, scheduledFor: { gt: scheduledFor } },
        select: { id: true },
      });
      if (newer) return recorded;

      const { next, transition } = applyCheck(
        {
          status: locked.status,
          consecutiveFailures: locked.consecutive_failures,
          consecutiveSuccesses: locked.consecutive_successes,
        },
        {
          failureThreshold: locked.failure_threshold,
          recoveryThreshold: locked.recovery_threshold,
        },
        result.success,
      );

      await tx.monitor.update({
        where: { id: locked.id },
        data: { ...next, lastCheckedAt: checkedAt },
      });
      if (next.status !== locked.status) {
        events.push({ type: "monitor.status_changed", monitorId: locked.id, status: next.status });
      }

      if (transition === "WENT_DOWN" && !result.success) {
        // The partial unique index allows only one open incident per monitor,
        // so check first rather than rely on an error mid-transaction.
        const open = await tx.incident.findFirst({
          where: { monitorId: locked.id, resolvedAt: null },
          select: { id: true },
        });
        if (!open) {
          const incident = await tx.incident.create({
            data: {
              monitorId: locked.id,
              startedAt: await streakStart(tx, locked.id, scheduledFor, false),
              causeErrorType: result.errorType,
              causeStatusCode: result.statusCode,
              causeMessage: result.errorMessage,
            },
          });
          await queueNotification(tx, locked.user_id, incident.id, "INCIDENT_OPENED");
          events.push({ type: "incident.opened", monitorId: locked.id, incidentId: incident.id });
        }
      }

      if (transition === "RECOVERED") {
        const open = await tx.incident.findFirst({
          where: { monitorId: locked.id, resolvedAt: null },
        });
        if (open) {
          // The outage ended with the first success of the recovery streak.
          const recoveredAt = await streakStart(tx, locked.id, scheduledFor, true);
          await tx.incident.update({
            where: { id: open.id },
            data: { resolvedAt: recoveredAt > open.startedAt ? recoveredAt : open.startedAt },
          });
          await queueNotification(tx, locked.user_id, open.id, "INCIDENT_RESOLVED");
          events.push({ type: "incident.resolved", monitorId: locked.id, incidentId: open.id });
        }
      }

      return recorded;
    });

    if (typeof record === "string") return record;
    await onRecorded?.(record);
    return "recorded";
  };
}
