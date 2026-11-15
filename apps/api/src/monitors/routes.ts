import type { Monitor } from "@pulsewatch/database";
import { createMonitorSchema, HTTP_METHODS, updateMonitorSchema } from "@pulsewatch/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuthGuard } from "../auth/guard.js";
import { dataEnvelope, errorResponseSchema } from "../http/schemas.js";
import type { MonitorService } from "./service.js";

interface MonitorRouteOptions {
  monitors: MonitorService;
  requireAuth: AuthGuard;
}

/**
 * The public shape of a monitor. Internal columns (owner ID, failure
 * counters, the scheduler's next_check_at) are not listed, so the response
 * serialiser removes them.
 */
const monitorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  method: z.enum(HTTP_METHODS),
  intervalSeconds: z.number().int(),
  timeoutMs: z.number().int(),
  failureThreshold: z.number().int(),
  recoveryThreshold: z.number().int(),
  paused: z.boolean(),
  status: z.enum(["PENDING", "UP", "DOWN"]),
  lastCheckedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function toMonitorDto(monitor: Monitor): z.infer<typeof monitorSchema> {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    failureThreshold: monitor.failureThreshold,
    recoveryThreshold: monitor.recoveryThreshold,
    paused: monitor.paused,
    status: monitor.status,
    lastCheckedAt: monitor.lastCheckedAt?.toISOString() ?? null,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

// Rejecting a malformed ID here means it never reaches the database, where a
// non-UUID string would cause a query error rather than a clean "not found".
const idParams = z.object({ id: z.uuid("Invalid monitor ID.") });

const one = dataEnvelope(monitorSchema);
const many = dataEnvelope(z.array(monitorSchema));
const TAGS = ["monitors"];
const errors = { 401: errorResponseSchema, 404: errorResponseSchema, 422: errorResponseSchema };

export const monitorRoutes: FastifyPluginAsyncZod<MonitorRouteOptions> = async (app, options) => {
  const { monitors, requireAuth } = options;

  // Applied to the whole plugin rather than route by route, so a route added
  // here later cannot be left unauthenticated by accident.
  //
  // It runs at onRequest, the first lifecycle stage, on purpose. Fastify
  // validates the body BEFORE preHandler hooks, so authenticating there would
  // let an anonymous caller receive validation errors (and learn the request
  // schema) without ever being asked who they are.
  app.addHook("onRequest", requireAuth);

  app.post(
    "/",
    {
      schema: {
        tags: TAGS,
        summary: "Create a monitor",
        body: createMonitorSchema,
        response: { 201: one, 401: errors[401], 409: errorResponseSchema, 422: errors[422] },
      },
    },
    async (request, reply) => {
      // The owner comes from the verified token, never from the request body.
      const monitor = await monitors.create(request.userId, request.body);
      return reply
        .status(201)
        .header("location", `/api/v1/monitors/${monitor.id}`)
        .send({ data: toMonitorDto(monitor) });
    },
  );

  app.get(
    "/",
    {
      schema: {
        tags: TAGS,
        summary: "List your monitors",
        response: { 200: many, 401: errors[401] },
      },
    },
    async (request) => ({ data: (await monitors.list(request.userId)).map(toMonitorDto) }),
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Get a monitor",
        params: idParams,
        response: { 200: one, ...errors },
      },
    },
    async (request) => ({
      data: toMonitorDto(await monitors.get(request.userId, request.params.id)),
    }),
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Update a monitor",
        description: "Partial update: send only the fields to change, including `paused`.",
        params: idParams,
        body: updateMonitorSchema,
        response: { 200: one, ...errors },
      },
    },
    async (request) => ({
      data: toMonitorDto(await monitors.update(request.userId, request.params.id, request.body)),
    }),
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: TAGS,
        summary: "Delete a monitor and its history",
        params: idParams,
        response: { 204: z.null(), 401: errors[401], 404: errors[404], 422: errors[422] },
      },
    },
    async (request, reply) => {
      await monitors.remove(request.userId, request.params.id);
      return reply.status(204).send(null);
    },
  );

  await Promise.resolve();
};
