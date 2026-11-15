import { Prisma, type Monitor, type PrismaClient } from "@pulsewatch/database";
import {
  MAX_MONITORS_PER_USER,
  type CreateMonitorInput,
  type UpdateMonitorInput,
} from "@pulsewatch/shared";
import { AppError, notFound } from "../errors.js";

export interface MonitorServiceOptions {
  db: PrismaClient;
  now: () => Date;
  /** Returns a number in [0, 1). Injected so tests get a predictable schedule offset. */
  random?: () => number;
  /** Overridable so the limit can be tested without creating 50 monitors. */
  maxMonitorsPerUser?: number;
}

/**
 * Every method takes the caller's user ID as its first argument and puts it
 * in the WHERE clause of every query. That is the whole authorisation model:
 * a monitor that belongs to someone else is simply not found.
 */
export interface MonitorService {
  create: (userId: string, input: CreateMonitorInput) => Promise<Monitor>;
  list: (userId: string) => Promise<Monitor[]>;
  get: (userId: string, monitorId: string) => Promise<Monitor>;
  update: (userId: string, monitorId: string, patch: UpdateMonitorInput) => Promise<Monitor>;
  remove: (userId: string, monitorId: string) => Promise<void>;
}

const monitorNotFound = (): AppError => notFound("Monitor not found.");

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

/** Removes keys whose value is undefined, so a partial update only names real changes. */
function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export function createMonitorService(options: MonitorServiceOptions): MonitorService {
  const { db, now } = options;
  const random = options.random ?? Math.random;
  const limit = options.maxMonitorsPerUser ?? MAX_MONITORS_PER_USER;

  /**
   * First check time for a new monitor: a random point within one interval.
   *
   * Without this jitter, every monitor created with a 60 s interval would
   * fire on the same second, producing a burst of work once a minute with
   * idle workers in between (the "thundering herd" problem). Spreading the
   * first check spreads every later one too.
   */
  function firstCheckAt(intervalSeconds: number): Date {
    return new Date(now().getTime() + Math.floor(random() * intervalSeconds * 1000));
  }

  return {
    async create(userId, input) {
      return db.$transaction(async (tx) => {
        // Lock the user's row for the rest of this transaction. Without it,
        // two simultaneous requests could both count 49 monitors, both pass
        // the check, and leave the account with 51. With it, the second
        // request waits here until the first has committed.
        const owner = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        if (owner.length === 0) throw monitorNotFound();

        const existing = await tx.monitor.count({ where: { userId } });
        if (existing >= limit) {
          throw new AppError(
            409,
            "LIMIT_REACHED",
            `You have reached the limit of ${limit} monitors.`,
          );
        }

        return tx.monitor.create({
          data: { ...input, userId, nextCheckAt: firstCheckAt(input.intervalSeconds) },
        });
      });
    },

    list(userId) {
      // No pagination: the per-user cap bounds this at a few dozen rows.
      return db.monitor.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    },

    async get(userId, monitorId) {
      const monitor = await db.monitor.findFirst({ where: { id: monitorId, userId } });
      if (!monitor) throw monitorNotFound();
      return monitor;
    },

    async update(userId, monitorId, patch) {
      return db.$transaction(async (tx) => {
        const current = await tx.monitor.findFirst({ where: { id: monitorId, userId } });
        if (!current) throw monitorNotFound();

        const urlChanged = patch.url !== undefined && patch.url !== current.url;
        const resumed = patch.paused === false && current.paused;
        const intervalChanged =
          patch.intervalSeconds !== undefined && patch.intervalSeconds !== current.intervalSeconds;

        if (urlChanged) {
          // The monitor now points at a different target, so what we knew
          // about the old one no longer applies: any open incident is closed
          // and the status starts again from PENDING.
          await tx.incident.updateMany({
            where: { monitorId, resolvedAt: null },
            data: { resolvedAt: now() },
          });
        }

        return tx.monitor.update({
          // userId is repeated here so that even this write cannot touch
          // another user's row, whatever happened above.
          where: { id: monitorId, userId },
          data: {
            ...definedOnly(patch),
            ...(urlChanged
              ? { status: "PENDING", consecutiveFailures: 0, consecutiveSuccesses: 0 }
              : {}),
            // A resumed or re-timed monitor is checked promptly instead of
            // waiting out a schedule computed from its old settings.
            ...(urlChanged || resumed || intervalChanged ? { nextCheckAt: now() } : {}),
          },
        });
      });
    },

    async remove(userId, monitorId) {
      try {
        // One statement, so there is no gap between "check ownership" and
        // "delete". History and incidents go with it (ON DELETE CASCADE).
        await db.monitor.delete({ where: { id: monitorId, userId } });
      } catch (error) {
        if (isRecordNotFound(error)) throw monitorNotFound();
        throw error;
      }
    },
  };
}
