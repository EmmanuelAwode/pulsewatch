import type { PrismaClient } from "@pulsewatch/database";
import { buildCheckJob, type CheckJob } from "./job.js";

export interface SchedulerOptions {
  db: PrismaClient;
  /** Hands jobs to the queue. Must reject if they could not be enqueued. */
  enqueue: (jobs: CheckJob[]) => Promise<void>;
  now: () => Date;
  /** Most monitors claimed per tick. Bounds transaction size and memory. */
  batchSize?: number;
}

export interface Scheduler {
  /** Claims the monitors that are due and enqueues a check for each. Returns how many. */
  tick: () => Promise<number>;
}

interface DueMonitor {
  id: string;
  interval_seconds: number;
  next_check_at: Date;
}

/**
 * The slot to check now, and the slot after it.
 *
 * Normally `dueAt` is at most a tick old and is itself the slot. After
 * downtime it may be hours old. Rather than enqueue every slot that was
 * missed (which would hammer the queue and the target, and could not measure
 * the past anyway), this skips forward to the most recent slot on the
 * monitor's own grid. The grid is preserved, so the jitter applied at
 * creation still spreads monitors out afterwards.
 */
export function currentAndNextSlot(
  dueAt: Date,
  intervalSeconds: number,
  now: Date,
): { slot: Date; next: Date } {
  const intervalMs = intervalSeconds * 1000;
  const missed = Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / intervalMs));
  const slot = new Date(dueAt.getTime() + missed * intervalMs);
  return { slot, next: new Date(slot.getTime() + intervalMs) };
}

/**
 * Turns "this monitor is due" (a row in Postgres) into "check it" (a job in
 * Redis). Postgres is the single source of truth for the schedule (ADR-002).
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, enqueue, now } = options;
  const batchSize = options.batchSize ?? 500;

  return {
    async tick() {
      return db.$transaction(async (tx) => {
        const currentTime = now();

        // FOR UPDATE locks the rows this scheduler will handle.
        // SKIP LOCKED makes any other scheduler instance pass over them
        // instead of waiting, so several schedulers can run at once and each
        // takes a different set. No leader election is needed.
        const due = await tx.$queryRaw<DueMonitor[]>`
          SELECT id, interval_seconds, next_check_at
          FROM monitors
          WHERE paused = false AND next_check_at <= ${currentTime}
          ORDER BY next_check_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`;
        if (due.length === 0) return 0;

        const planned = due.map((monitor) => {
          const { slot, next } = currentAndNextSlot(
            monitor.next_check_at,
            monitor.interval_seconds,
            currentTime,
          );
          return { id: monitor.id, next, job: buildCheckJob(monitor.id, slot) };
        });

        // Order matters. The jobs are enqueued BEFORE the schedule advances.
        //
        // If this process dies after enqueueing but before the commit below,
        // the transaction rolls back, the monitors are still due, and the
        // next tick enqueues the same job IDs again: a harmless duplicate.
        // Committing first would instead advance the schedule with no job
        // queued, silently losing a check. Duplicates are safe; losses are not.
        await enqueue(planned.map((entry) => entry.job));

        await tx.$executeRaw`
          UPDATE monitors AS m
          SET next_check_at = planned.next_check_at
          FROM unnest(
            ${planned.map((entry) => entry.id)}::uuid[],
            ${planned.map((entry) => entry.next)}::timestamptz[]
          ) AS planned(id, next_check_at)
          WHERE m.id = planned.id`;

        return planned.length;
      });
    },
  };
}
