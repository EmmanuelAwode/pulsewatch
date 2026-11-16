import type { FastifyInstance } from "fastify";
import { collectDefaultMetrics, Histogram, Registry } from "prom-client";

/**
 * Prometheus metrics for the API: request latency by route and status code,
 * plus Node.js process metrics. Served at GET /metrics.
 *
 * The route label is the route PATTERN (/api/v1/monitors/:id), never the raw
 * URL. Raw URLs contain IDs, and one label value per ID would create an
 * unbounded number of time series and exhaust Prometheus memory.
 *
 * /metrics is for the internal network only. The reverse proxy in deployment
 * does not route it (docs/deployment.md).
 */
export function registerMetrics(app: FastifyInstance): void {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "pulsewatch_api_" });

  const duration = new Histogram({
    name: "pulsewatch_http_request_duration_seconds",
    help: "HTTP request duration, by method, route pattern and status code.",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook("onResponse", async (request, reply) => {
    duration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status_code: reply.statusCode,
      },
      reply.elapsedTime / 1000,
    );
    await Promise.resolve();
  });

  app.get(
    "/metrics",
    { config: { rateLimit: false }, schema: { hide: true } },
    async (_request, reply) => {
      return reply.header("content-type", registry.contentType).send(await registry.metrics());
    },
  );
}
