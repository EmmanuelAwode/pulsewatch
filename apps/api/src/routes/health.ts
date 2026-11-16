import type { PrismaClient } from "@pulsewatch/database";
import type { Redis } from "ioredis";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { serviceUnavailable } from "../errors.js";
import { dataEnvelope, errorResponseSchema } from "../http/schemas.js";

/** A dependency that has not answered within this time counts as down. */
const READINESS_TIMEOUT_MS = 2_000;

interface HealthRouteOptions {
  db: PrismaClient;
  redis: Redis;
}

/** Rejects if `work` has not settled within `ms`. The timer never keeps the process alive. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness and readiness are different questions, deliberately answered by
 * different endpoints:
 *
 *   /healthz  "Is this process running?"  Checks nothing external. If it
 *             fails, the orchestrator should RESTART the container.
 *   /readyz   "Can this process serve traffic right now?"  Checks its
 *             dependencies. If it fails, the load balancer should stop
 *             ROUTING to this instance, but restarting it would not help.
 *
 * If liveness checked the database, a short database outage would make the
 * orchestrator restart every API container at once and turn a partial outage
 * into a total one.
 */
export const healthRoutes: FastifyPluginAsyncZod<HealthRouteOptions> = async (
  app,
  { db, redis },
) => {
  app.get(
    "/healthz",
    {
      // Probes run every few seconds from inside the network; never limit them.
      config: { rateLimit: false },
      schema: {
        tags: ["operations"],
        summary: "Liveness probe",
        response: { 200: dataEnvelope(z.object({ status: z.literal("ok") })) },
      },
    },
    () => ({ data: { status: "ok" as const } }),
  );

  app.get(
    "/readyz",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["operations"],
        summary: "Readiness probe",
        response: {
          200: dataEnvelope(
            z.object({
              status: z.literal("ready"),
              checks: z.object({ database: z.literal("ok"), redis: z.literal("ok") }),
            }),
          ),
          503: errorResponseSchema,
        },
      },
    },
    async (request) => {
      // Both dependencies are checked in parallel, each with its own timeout,
      // and every failure is reported, not just the first.
      const probes = {
        database: () => db.$queryRaw`SELECT 1`,
        redis: () => redis.ping(),
      };
      const results = await Promise.allSettled(
        Object.values(probes).map((probe) => withTimeout(probe(), READINESS_TIMEOUT_MS)),
      );
      const failed = Object.keys(probes).filter(
        (_, index) => results[index]?.status === "rejected",
      );
      if (failed.length > 0) {
        // The causes go to the log. The response only names which dependency
        // failed, because driver errors can contain hostnames and credentials.
        request.log.warn({ failed }, "readiness check failed");
        throw serviceUnavailable(
          "The service is not ready.",
          failed.map((name) => ({ path: name, message: "unreachable" })),
        );
      }
      return {
        data: {
          status: "ready" as const,
          checks: { database: "ok" as const, redis: "ok" as const },
        },
      };
    },
  );

  await Promise.resolve();
};
