/** The BullMQ queue that carries check jobs from the scheduler to the processors. */
export const CHECK_QUEUE = "checks";

/** What a check job carries. Deliberately tiny: the processor reads everything else fresh. */
export interface CheckJobData {
  monitorId: string;
  /** ISO 8601 UTC timestamp of the schedule slot this check belongs to. */
  scheduledFor: string;
}

export interface CheckJob {
  id: string;
  data: CheckJobData;
}

/**
 * A job's identity is (monitor, slot), not "when it happened to be enqueued".
 *
 * Two attempts to enqueue the same slot therefore produce the same ID, and
 * the queue keeps only one. That is the first of two duplicate guards; the
 * second, which holds even if Redis is wiped, is the unique constraint on
 * check_results (ADR-003).
 *
 * BullMQ forbids ":" in custom job IDs, hence the "_" separators.
 */
export function checkJobId(monitorId: string, slot: Date): string {
  return `check_${monitorId}_${slot.getTime()}`;
}

export function buildCheckJob(monitorId: string, slot: Date): CheckJob {
  return {
    id: checkJobId(monitorId, slot),
    data: { monitorId, scheduledFor: slot.toISOString() },
  };
}
