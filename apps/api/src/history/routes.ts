import type { CheckResult } from "@pulsewatch/database";
import { ANALYTICS_RANGE_KEYS } from "@pulsewatch/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuthGuard } from "../auth/guard.js";
import { pageQuery } from "../http/cursor.js";
import { dataEnvelope, errorResponseSchema } from "../http/schemas.js";
import type { HistoryService, IncidentRow } from "./service.js";

interface HistoryRouteOptions {
  history: HistoryService;
  requireAuth: AuthGuard;
  now: () => Date;
}

const iso = z.iso.datetime();
const STATUSES = ["PENDING", "UP", "DOWN"] as const;

const checkSchema = z.object({
  // check_results.id is a 64-bit integer, which a JavaScript number cannot
  // hold exactly, so it travels as a string.
  id: z.string(),
  scheduledFor: iso,
  checkedAt: iso,
  success: z.boolean(),
  statusCode: z.number().int().nullable(),
  responseTimeMs: z.number().int().nullable(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

function toCheckDto(check: CheckResult): z.infer<typeof checkSchema> {
  return {
    id: check.id.toString(),
    scheduledFor: check.scheduledFor.toISOString(),
    checkedAt: check.checkedAt.toISOString(),
    success: check.success,
    statusCode: check.statusCode,
    responseTimeMs: check.responseTimeMs,
    errorType: check.errorType,
    errorMessage: check.errorMessage,
  };
}

const incidentSchema = z.object({
  id: z.uuid(),
  monitorId: z.uuid(),
  monitorName: z.string(),
  startedAt: iso,
  resolvedAt: iso.nullable(),
  /** Resolved: how long it lasted. Open: how long it has lasted so far. */
  durationSeconds: z.number().int(),
  cause: z.object({
    errorType: z.string(),
    statusCode: z.number().int().nullable(),
    message: z.string().nullable(),
  }),
});

function toIncidentDto(incident: IncidentRow, now: Date): z.infer<typeof incidentSchema> {
  const end = incident.resolvedAt ?? now;
  return {
    id: incident.id,
    monitorId: incident.monitorId,
    monitorName: incident.monitorName,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    durationSeconds: Math.max(0, Math.round((end.getTime() - incident.startedAt.getTime()) / 1000)),
    cause: {
      errorType: incident.causeErrorType,
      statusCode: incident.causeStatusCode,
      message: incident.causeMessage,
    },
  };
}

const nullableNumber = z.number().nullable();

const analyticsSchema = z.object({
  range: z.enum(ANALYTICS_RANGE_KEYS),
  from: iso,
  to: iso,
  checks: z.number().int(),
  successful: z.number().int(),
  failed: z.number().int(),
  expectedChecks: z.number().int(),
  uptimePercent: nullableNumber,
  responseTimeMs: z.object({ avg: nullableNumber, p50: nullableNumber, p95: nullableNumber }),
  series: z.array(
    z.object({
      bucketStart: iso,
      checks: z.number().int(),
      successful: z.number().int(),
      uptimePercent: nullableNumber,
      avgResponseMs: nullableNumber,
      p95ResponseMs: nullableNumber,
    }),
  ),
});

const dashboardSchema = z.object({
  counts: z.object({
    total: z.number().int(),
    up: z.number().int(),
    down: z.number().int(),
    pending: z.number().int(),
    paused: z.number().int(),
  }),
  openIncidents: z.number().int(),
  last24h: z.object({
    checks: z.number().int(),
    uptimePercent: nullableNumber,
    avgResponseMs: nullableNumber,
  }),
  monitors: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      url: z.string(),
      status: z.enum(STATUSES),
      paused: z.boolean(),
      intervalSeconds: z.number().int(),
      lastCheckedAt: iso.nullable(),
      checks24h: z.number().int(),
      uptimePercent24h: nullableNumber,
      avgResponseMs24h: nullableNumber,
    }),
  ),
});

function listEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: z.object({ nextCursor: z.string().nullable() }) });
}

const monitorParams = z.object({ id: z.uuid("Invalid monitor ID.") });
const checkParams = z.object({
  id: z.uuid("Invalid monitor ID."),
  checkId: z.string().regex(/^\d{1,18}$/, "Invalid check ID."),
});
const errors = { 401: errorResponseSchema, 404: errorResponseSchema, 422: errorResponseSchema };
const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

export const historyRoutes: FastifyPluginAsyncZod<HistoryRouteOptions> = async (app, options) => {
  const { history, requireAuth, now } = options;
  app.addHook("onRequest", requireAuth);

  app.get(
    "/monitors/:id/checks",
    {
      schema: {
        tags: ["history"],
        summary: "Check results for a monitor, newest first",
        params: monitorParams,
        querystring: z.object({ ...pageQuery, success: booleanQuery.optional() }),
        response: { 200: listEnvelope(checkSchema), ...errors },
      },
    },
    async (request) => {
      const page = await history.listChecks(request.userId, request.params.id, request.query);
      return { data: page.items.map(toCheckDto), meta: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    "/monitors/:id/checks/:checkId",
    {
      schema: {
        tags: ["history"],
        summary: "One check result in full",
        params: checkParams,
        response: { 200: dataEnvelope(checkSchema), ...errors },
      },
    },
    async (request) => {
      const check = await history.getCheck(
        request.userId,
        request.params.id,
        BigInt(request.params.checkId),
      );
      return { data: toCheckDto(check) };
    },
  );

  app.get(
    "/monitors/:id/analytics",
    {
      schema: {
        tags: ["history"],
        summary: "Uptime and response-time statistics",
        description:
          "Uptime counts recorded checks only; compare `checks` with `expectedChecks` to see coverage. Response-time figures use successful checks only.",
        params: monitorParams,
        querystring: z.object({ range: z.enum(ANALYTICS_RANGE_KEYS).default("24h") }),
        response: { 200: dataEnvelope(analyticsSchema), ...errors },
      },
    },
    async (request) => {
      const result = await history.analytics(
        request.userId,
        request.params.id,
        request.query.range,
      );
      return {
        data: {
          ...result,
          from: result.from.toISOString(),
          to: result.to.toISOString(),
          series: result.series.map((point) => ({
            ...point,
            bucketStart: point.bucketStart.toISOString(),
          })),
        },
      };
    },
  );

  app.get(
    "/monitors/:id/incidents",
    {
      schema: {
        tags: ["history"],
        summary: "Incidents for one monitor, newest first",
        params: monitorParams,
        querystring: z.object(pageQuery),
        response: { 200: listEnvelope(incidentSchema), ...errors },
      },
    },
    async (request) => {
      const page = await history.listIncidents(request.userId, {
        ...request.query,
        monitorId: request.params.id,
        status: "all",
      });
      const at = now();
      return {
        data: page.items.map((incident) => toIncidentDto(incident, at)),
        meta: { nextCursor: page.nextCursor },
      };
    },
  );

  app.get(
    "/incidents",
    {
      schema: {
        tags: ["history"],
        summary: "Incidents across all your monitors, newest first",
        querystring: z.object({
          ...pageQuery,
          status: z.enum(["open", "resolved", "all"]).default("all"),
        }),
        response: {
          200: listEnvelope(incidentSchema),
          401: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const page = await history.listIncidents(request.userId, request.query);
      const at = now();
      return {
        data: page.items.map((incident) => toIncidentDto(incident, at)),
        meta: { nextCursor: page.nextCursor },
      };
    },
  );

  app.get(
    "/dashboard",
    {
      schema: {
        tags: ["history"],
        summary: "Overview: status counts, open incidents and 24-hour figures per monitor",
        response: { 200: dataEnvelope(dashboardSchema), 401: errorResponseSchema },
      },
    },
    async (request) => {
      const result = await history.dashboard(request.userId);
      return {
        data: {
          ...result,
          monitors: result.monitors.map((monitor) => ({
            ...monitor,
            lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
          })),
        },
      };
    },
  );

  await Promise.resolve();
};
