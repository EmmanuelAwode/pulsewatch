import type { Server } from "node:http";
import { createDatabaseClient } from "@pulsewatch/database";
import { pino } from "pino";
import { ConfigError, loadConfig } from "./config.js";
import { createWorkerMetrics, startMetricsServer } from "./metrics.js";
import { createLogMailer, createSmtpMailer } from "./notifications/mailer.js";
import { createProber } from "./probe/prober.js";
import { startWorkerRuntime } from "./runtime.js";

/** If in-flight checks have not finished by then, exit anyway. Longer than the 30 s check timeout. */
const SHUTDOWN_TIMEOUT_MS = 40_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({ level: config.logLevel });
  // Each running check holds a connection briefly when it stores its result,
  // so the pool is sized to the concurrency, with headroom for the loops.
  const db = createDatabaseClient({
    connectionString: config.databaseUrl,
    maxConnections: Math.min(config.concurrency + 4, 50),
  });
  const mailer = config.smtpUrl
    ? createSmtpMailer(config.smtpUrl, config.mailFrom)
    : createLogMailer(logger);

  const runtime = startWorkerRuntime({
    config,
    db,
    probe: createProber(),
    logger,
    mailer,
    createMetrics: createWorkerMetrics,
  });
  let metricsServer: Server | undefined;
  if (runtime.metrics) {
    metricsServer = await startMetricsServer(
      runtime.metrics.registry,
      config.metricsHost,
      config.metricsPort,
    );
  }
  logger.info(
    { concurrency: config.concurrency, email: config.smtpUrl ? "smtp" : "log only" },
    "worker started",
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error({}, "shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    metricsServer?.close();
    runtime
      .stop()
      .then(() => db.$disconnect())
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Failed to start:", error);
  }
  process.exit(1);
});
