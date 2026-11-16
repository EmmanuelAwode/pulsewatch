import type { PrismaClient } from "@pulsewatch/database";
import type { Mailer } from "./mailer.js";
import { renderAlert } from "./templates.js";

export interface NotificationSenderOptions {
  db: PrismaClient;
  mailer: Mailer;
  now: () => Date;
  /** Attempts before a delivery is given up as FAILED. */
  maxAttempts?: number;
  /** Most deliveries handled per sweep. */
  batchSize?: number;
}

export interface SweepResult {
  sent: number;
  /** Failed this time and scheduled for another attempt. */
  retrying: number;
  /** Failed for the last time. */
  failed: number;
}

export interface NotificationSender {
  /** Delivers every due notification, one at a time, up to the batch size. */
  sweep: () => Promise<SweepResult>;
}

interface DueDelivery {
  id: string;
  event: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
  recipient: string;
  attempts: number;
  started_at: Date;
  resolved_at: Date | null;
  cause_message: string | null;
  monitor_name: string;
  monitor_url: string;
}

/** Wait before retry number `attempt` (1-based): 1, 2, 4, 8, 16 minutes. */
export function retryDelayMs(attempt: number): number {
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

/**
 * Error text is stored for debugging, but SMTP errors can echo credentials or
 * server details, so only a short, single-line prefix is kept.
 */
function summariseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
}

/**
 * Delivers the alerts that the check processor queued in the outbox.
 *
 * Each delivery is handled in its own transaction that holds a row lock
 * (FOR UPDATE SKIP LOCKED) for the whole send. That is what stops two worker
 * processes sending the same email: the second skips the locked row. The cost
 * is a transaction held open during one SMTP call; that is acceptable here
 * because sends are rare and one-at-a-time, unlike checks (ADR-023).
 *
 * At-least-once, not exactly-once: if the SMTP server accepts the message and
 * this process dies before the commit, the email is sent again on the next
 * attempt. Email has no idempotency key, so this cannot be fully removed.
 */
export function createNotificationSender(options: NotificationSenderOptions): NotificationSender {
  const { db, mailer, now } = options;
  const maxAttempts = options.maxAttempts ?? 5;
  const batchSize = options.batchSize ?? 20;

  async function sendOne(): Promise<keyof SweepResult | null> {
    return db.$transaction(
      async (tx) => {
        const currentTime = now();
        const [delivery] = await tx.$queryRaw<DueDelivery[]>`
          SELECT d.id, d.event, d.recipient, d.attempts,
                 i.started_at, i.resolved_at, i.cause_message,
                 m.name AS monitor_name, m.url AS monitor_url
          FROM notification_deliveries d
          JOIN incidents i ON i.id = d.incident_id
          JOIN monitors m ON m.id = i.monitor_id
          WHERE d.status = 'PENDING' AND d.next_attempt_at <= ${currentTime}
          ORDER BY d.next_attempt_at
          LIMIT 1
          FOR UPDATE OF d SKIP LOCKED`;
        if (!delivery) return null;

        const attempt = delivery.attempts + 1;
        try {
          await mailer(
            renderAlert({
              event: delivery.event,
              recipient: delivery.recipient,
              monitorName: delivery.monitor_name,
              monitorUrl: delivery.monitor_url,
              startedAt: delivery.started_at,
              resolvedAt: delivery.resolved_at,
              causeMessage: delivery.cause_message,
            }),
          );
        } catch (error) {
          const giveUp = attempt >= maxAttempts;
          await tx.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
              attempts: attempt,
              lastError: summariseError(error),
              status: giveUp ? "FAILED" : "PENDING",
              nextAttemptAt: new Date(currentTime.getTime() + retryDelayMs(attempt)),
            },
          });
          return giveUp ? "failed" : "retrying";
        }

        await tx.notificationDelivery.update({
          where: { id: delivery.id },
          data: { attempts: attempt, status: "SENT", sentAt: currentTime, lastError: null },
        });
        return "sent";
      },
      // An SMTP round trip can take several seconds; Prisma's default
      // interactive-transaction timeout is 5 s.
      { timeout: 30_000 },
    );
  }

  return {
    async sweep() {
      const totals: SweepResult = { sent: 0, retrying: 0, failed: 0 };
      for (let index = 0; index < batchSize; index += 1) {
        const outcome = await sendOne();
        if (!outcome) break;
        totals[outcome] += 1;
      }
      return totals;
    },
  };
}
