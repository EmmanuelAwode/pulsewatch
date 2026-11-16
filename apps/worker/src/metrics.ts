import { createServer, type Server } from "node:http";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { RecordedCheck } from "./checks/processor.js";

export interface WorkerMetrics {
  registry: Registry;
  recordCheck: (record: RecordedCheck) => void;
  recordEnqueued: (count: number) => void;
  recordNotifications: (outcome: "sent" | "retrying" | "failed", count: number) => void;
}

/**
 * Prometheus metrics for the worker. A registry per instance (not the global
 * default) so tests can create several without "already registered" errors.
 *
 * The metrics answer the operational questions this service raises:
 *   - Are checks running, and how many fail, and why?    checks_total
 *   - Are we keeping up with the schedule?                check_lag_seconds
 *   - Is work piling up?                                  queue_jobs
 *   - Are alerts going out?                               notifications_total
 */
export function createWorkerMetrics(
  queueCounts?: () => Promise<Record<string, number>>,
): WorkerMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "pulsewatch_worker_" });

  const checks = new Counter({
    name: "pulsewatch_checks_total",
    help: "Checks recorded, by result and failure type.",
    labelNames: ["result", "error_type"],
    registers: [registry],
  });
  const responseTime = new Histogram({
    name: "pulsewatch_check_response_seconds",
    help: "Response time of successful and HTTP-error checks.",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const lag = new Histogram({
    name: "pulsewatch_check_lag_seconds",
    help: "Delay between a check's scheduled slot and its request starting. Rising lag means the workers are not keeping up.",
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });
  const transitions = new Counter({
    name: "pulsewatch_status_changes_total",
    help: "Monitor status changes, by new status.",
    labelNames: ["status"],
    registers: [registry],
  });
  const enqueued = new Counter({
    name: "pulsewatch_scheduler_enqueued_total",
    help: "Check jobs handed to the queue by the scheduler.",
    registers: [registry],
  });
  const notifications = new Counter({
    name: "pulsewatch_notifications_total",
    help: "Alert delivery attempts, by outcome.",
    labelNames: ["outcome"],
    registers: [registry],
  });

  if (queueCounts) {
    // Read from Redis at scrape time rather than tracked by hand, so it is
    // always the queue's real state.
    new Gauge({
      name: "pulsewatch_queue_jobs",
      help: "Jobs in the check queue, by state.",
      labelNames: ["state"],
      registers: [registry],
      async collect() {
        const counts = await queueCounts();
        for (const [state, count] of Object.entries(counts)) this.set({ state }, count);
      },
    });
  }

  return {
    registry,
    recordCheck(record) {
      const { result } = record;
      checks.inc({
        result: result.success ? "up" : "down",
        error_type: result.success ? "none" : result.errorType,
      });
      if (result.responseTimeMs !== null) responseTime.observe(result.responseTimeMs / 1000);
      lag.observe(Math.max(0, record.checkedAt.getTime() - record.scheduledFor.getTime()) / 1000);
      for (const event of record.events) {
        if (event.type === "monitor.status_changed") transitions.inc({ status: event.status });
      }
    },
    recordEnqueued(count) {
      enqueued.inc(count);
    },
    recordNotifications(outcome, count) {
      if (count > 0) notifications.inc({ outcome }, count);
    },
  };
}

/**
 * A tiny HTTP server for Prometheus to scrape, plus a liveness probe. It must
 * not be exposed publicly; in Compose it is only reachable on the internal
 * network.
 */
export function startMetricsServer(
  registry: Registry,
  host: string,
  port: number,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (request.url === "/metrics") {
      registry
        .metrics()
        .then((body) => {
          response.writeHead(200, { "content-type": registry.contentType }).end(body);
        })
        .catch(() => {
          response.writeHead(500).end();
        });
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}
