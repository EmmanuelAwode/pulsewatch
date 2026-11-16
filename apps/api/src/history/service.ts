import { Prisma, type CheckResult, type PrismaClient } from "@pulsewatch/database";
import { ANALYTICS_RANGES, type AnalyticsRange } from "@pulsewatch/shared";
import { z } from "zod";
import { notFound } from "../errors.js";
import { decodeCursor, encodeCursor } from "../http/cursor.js";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface IncidentRow {
  id: string;
  monitorId: string;
  monitorName: string;
  startedAt: Date;
  resolvedAt: Date | null;
  causeErrorType: string;
  causeStatusCode: number | null;
  causeMessage: string | null;
}

export interface Analytics {
  range: AnalyticsRange;
  from: Date;
  to: Date;
  checks: number;
  successful: number;
  failed: number;
  /** Checks the schedule called for in the window. Fewer recorded = gaps in coverage. */
  expectedChecks: number;
  uptimePercent: number | null;
  responseTimeMs: { avg: number | null; p50: number | null; p95: number | null };
  series: {
    bucketStart: Date;
    checks: number;
    successful: number;
    uptimePercent: number | null;
    avgResponseMs: number | null;
    p95ResponseMs: number | null;
  }[];
}

export interface DashboardMonitor {
  id: string;
  name: string;
  url: string;
  status: "PENDING" | "UP" | "DOWN";
  paused: boolean;
  intervalSeconds: number;
  lastCheckedAt: Date | null;
  checks24h: number;
  uptimePercent24h: number | null;
  avgResponseMs24h: number | null;
}

export interface Dashboard {
  counts: { total: number; up: number; down: number; pending: number; paused: number };
  openIncidents: number;
  last24h: { checks: number; uptimePercent: number | null; avgResponseMs: number | null };
  monitors: DashboardMonitor[];
}

export interface HistoryService {
  listChecks: (
    userId: string,
    monitorId: string,
    query: { cursor?: string | undefined; limit: number; success?: boolean | undefined },
  ) => Promise<Page<CheckResult>>;
  getCheck: (userId: string, monitorId: string, checkId: bigint) => Promise<CheckResult>;
  analytics: (userId: string, monitorId: string, range: AnalyticsRange) => Promise<Analytics>;
  listIncidents: (
    userId: string,
    query: {
      monitorId?: string | undefined;
      status: "open" | "resolved" | "all";
      cursor?: string | undefined;
      limit: number;
    },
  ) => Promise<Page<IncidentRow>>;
  dashboard: (userId: string) => Promise<Dashboard>;
}

const checkCursor = z.object({ s: z.iso.datetime() });
const incidentCursor = z.object({ s: z.iso.datetime(), i: z.uuid() });

const round = (value: number | null, digits: number): number | null =>
  value === null ? null : Number(value.toFixed(digits));

const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : round((part / whole) * 100, 3);

/**
 * Read-side queries: history, analytics, incidents, dashboard.
 *
 * Every aggregate is computed by PostgreSQL. Nothing here loads a monitor's
 * history into memory: a 30-day window can be 43,200 rows per monitor, and
 * the database can scan and aggregate them through the index far faster
 * than shipping them to Node would.
 */
export function createHistoryService(options: {
  db: PrismaClient;
  now: () => Date;
}): HistoryService {
  const { db, now } = options;

  /** Ownership check shared by every per-monitor query: not yours = not found. */
  async function ownedMonitor(userId: string, monitorId: string) {
    const monitor = await db.monitor.findFirst({ where: { id: monitorId, userId } });
    if (!monitor) throw notFound("Monitor not found.");
    return monitor;
  }

  return {
    async listChecks(userId, monitorId, query) {
      await ownedMonitor(userId, monitorId);
      const before = query.cursor ? new Date(decodeCursor(query.cursor, checkCursor).s) : undefined;

      // Fetch one extra row to learn whether another page exists without a
      // separate COUNT query.
      const rows = await db.checkResult.findMany({
        where: {
          monitorId,
          ...(before ? { scheduledFor: { lt: before } } : {}),
          ...(query.success === undefined ? {} : { success: query.success }),
        },
        orderBy: { scheduledFor: "desc" },
        take: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ s: last.scheduledFor.toISOString() })
            : null,
      };
    },

    async getCheck(userId, monitorId, checkId) {
      await ownedMonitor(userId, monitorId);
      const check = await db.checkResult.findFirst({ where: { id: checkId, monitorId } });
      if (!check) throw notFound("Check not found.");
      return check;
    },

    async analytics(userId, monitorId, range) {
      const monitor = await ownedMonitor(userId, monitorId);
      const { durationSeconds, bucketSeconds } = ANALYTICS_RANGES[range];
      const to = now();
      const from = new Date(to.getTime() - durationSeconds * 1000);

      // Latency statistics use successful checks only: a timeout's "latency"
      // is just the timeout setting and would distort the percentiles.
      const [totals] = await db.$queryRaw<
        {
          checks: number;
          successful: number;
          avg: number | null;
          p50: number | null;
          p95: number | null;
        }[]
      >`
        SELECT count(*)::int AS checks,
               count(*) FILTER (WHERE success)::int AS successful,
               avg(response_time_ms) FILTER (WHERE success)::float8 AS avg,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)
                 FILTER (WHERE success) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms)
                 FILTER (WHERE success) AS p95
        FROM check_results
        WHERE monitor_id = ${monitorId}::uuid
          AND scheduled_for >= ${from} AND scheduled_for < ${to}`;

      const buckets = await db.$queryRaw<
        {
          bucket: Date;
          checks: number;
          successful: number;
          avg: number | null;
          p95: number | null;
        }[]
      >`
        SELECT date_bin(${bucketSeconds} * interval '1 second', scheduled_for, ${from}) AS bucket,
               count(*)::int AS checks,
               count(*) FILTER (WHERE success)::int AS successful,
               avg(response_time_ms) FILTER (WHERE success)::float8 AS avg,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms)
                 FILTER (WHERE success) AS p95
        FROM check_results
        WHERE monitor_id = ${monitorId}::uuid
          AND scheduled_for >= ${from} AND scheduled_for < ${to}
        GROUP BY 1
        ORDER BY 1`;

      // Emit every bucket, including empty ones, so a chart shows a gap in
      // coverage as a gap rather than silently joining the points around it.
      const byStart = new Map(buckets.map((row) => [row.bucket.getTime(), row]));
      const series: Analytics["series"] = [];
      const bucketCount = Math.round(durationSeconds / bucketSeconds);
      for (let index = 0; index < bucketCount; index += 1) {
        const bucketStart = new Date(from.getTime() + index * bucketSeconds * 1000);
        const row = byStart.get(bucketStart.getTime());
        series.push({
          bucketStart,
          checks: row?.checks ?? 0,
          successful: row?.successful ?? 0,
          uptimePercent: row ? percent(row.successful, row.checks) : null,
          avgResponseMs: round(row?.avg ?? null, 1),
          p95ResponseMs: round(row?.p95 ?? null, 1),
        });
      }

      // Missing slots are not counted as downtime (ADR-011). expectedChecks
      // lets a client show when the recorded data is incomplete.
      const coveredFrom = Math.max(from.getTime(), monitor.createdAt.getTime());
      const expectedChecks = Math.max(
        0,
        Math.floor((to.getTime() - coveredFrom) / (monitor.intervalSeconds * 1000)),
      );

      const checks = totals?.checks ?? 0;
      const successful = totals?.successful ?? 0;
      return {
        range,
        from,
        to,
        checks,
        successful,
        failed: checks - successful,
        expectedChecks,
        uptimePercent: percent(successful, checks),
        responseTimeMs: {
          avg: round(totals?.avg ?? null, 1),
          p50: round(totals?.p50 ?? null, 1),
          p95: round(totals?.p95 ?? null, 1),
        },
        series,
      };
    },

    async listIncidents(userId, query) {
      if (query.monitorId) await ownedMonitor(userId, query.monitorId);
      const after = query.cursor ? decodeCursor(query.cursor, incidentCursor) : undefined;

      const conditions = [Prisma.sql`m.user_id = ${userId}::uuid`];
      if (query.monitorId) conditions.push(Prisma.sql`i.monitor_id = ${query.monitorId}::uuid`);
      if (query.status === "open") conditions.push(Prisma.sql`i.resolved_at IS NULL`);
      if (query.status === "resolved") conditions.push(Prisma.sql`i.resolved_at IS NOT NULL`);
      // Two incidents can start at the same instant, so the cursor is the
      // pair (started_at, id): a row comparison keeps the order total.
      if (after) {
        conditions.push(
          Prisma.sql`(i.started_at, i.id) < (${new Date(after.s)}, ${after.i}::uuid)`,
        );
      }

      const rows = await db.$queryRaw<IncidentRow[]>`
        SELECT i.id, i.monitor_id AS "monitorId", m.name AS "monitorName",
               i.started_at AS "startedAt", i.resolved_at AS "resolvedAt",
               i.cause_error_type::text AS "causeErrorType",
               i.cause_status_code AS "causeStatusCode", i.cause_message AS "causeMessage"
        FROM incidents i
        JOIN monitors m ON m.id = i.monitor_id
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY i.started_at DESC, i.id DESC
        LIMIT ${query.limit + 1}`;

      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ s: last.startedAt.toISOString(), i: last.id })
            : null,
      };
    },

    async dashboard(userId) {
      const to = now();
      const from = new Date(to.getTime() - 24 * 3_600_000);

      const monitors = await db.monitor.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      // One grouped query for every monitor's last 24 hours (the per-user cap
      // bounds this at 50 monitors x 1,440 rows).
      //
      // It filters on monitor_id = ANY(ids) rather than joining monitors to
      // check_results. With the join, PostgreSQL chose a parallel sequential
      // scan of the whole table: 70 ms at 1.7 million rows, and growing with
      // every user's history. A list of IDs lets it use the
      // (monitor_id, scheduled_for) index for each monitor instead. Found
      // with EXPLAIN ANALYZE after a load test (ADR-025).
      const stats =
        monitors.length === 0
          ? []
          : await db.$queryRaw<
              { id: string; checks: number; successful: number; avg: number | null }[]
            >`
              SELECT monitor_id AS id,
                     count(*)::int AS checks,
                     count(*) FILTER (WHERE success)::int AS successful,
                     avg(response_time_ms) FILTER (WHERE success)::float8 AS avg
              FROM check_results
              WHERE monitor_id = ANY(${monitors.map((monitor) => monitor.id)}::uuid[])
                AND scheduled_for >= ${from} AND scheduled_for < ${to}
              GROUP BY monitor_id`;
      const statsById = new Map(stats.map((row) => [row.id, row]));

      const openIncidents = await db.incident.count({
        where: { resolvedAt: null, monitor: { userId } },
      });

      const rows: DashboardMonitor[] = monitors.map((monitor) => {
        const row = statsById.get(monitor.id);
        return {
          id: monitor.id,
          name: monitor.name,
          url: monitor.url,
          status: monitor.status,
          paused: monitor.paused,
          intervalSeconds: monitor.intervalSeconds,
          lastCheckedAt: monitor.lastCheckedAt,
          checks24h: row?.checks ?? 0,
          uptimePercent24h: row ? percent(row.successful, row.checks) : null,
          avgResponseMs24h: round(row?.avg ?? null, 1),
        };
      });

      // Overall figures weight every check equally, and the average latency
      // is weighted by each monitor's number of successful checks.
      const checks = stats.reduce((sum, row) => sum + row.checks, 0);
      const successful = stats.reduce((sum, row) => sum + row.successful, 0);
      const latencyTotal = stats.reduce((sum, row) => sum + (row.avg ?? 0) * row.successful, 0);

      return {
        counts: {
          total: monitors.length,
          up: monitors.filter((monitor) => !monitor.paused && monitor.status === "UP").length,
          down: monitors.filter((monitor) => !monitor.paused && monitor.status === "DOWN").length,
          pending: monitors.filter((monitor) => !monitor.paused && monitor.status === "PENDING")
            .length,
          paused: monitors.filter((monitor) => monitor.paused).length,
        },
        openIncidents,
        last24h: {
          checks,
          uptimePercent: percent(successful, checks),
          avgResponseMs: successful === 0 ? null : round(latencyTotal / successful, 1),
        },
        monitors: rows,
      };
    },
  };
}
