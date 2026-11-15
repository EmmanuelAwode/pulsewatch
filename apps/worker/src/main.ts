import { createDatabaseClient } from "@pulsewatch/database";
import { pino } from "pino";
import { ConfigError, loadConfig } from "./config.js";
import { createProber } from "./probe/prober.js";
import { startWorkerRuntime } from "./runtime.js";

/** If in-flight checks have not finished by then, exit anyway. Longer than the 30 s check timeout. */
const SHUTDOWN_TIMEOUT_MS = 40_000;

function main(): void {
  const config = loadConfig(process.env);
  const logger = pino({ level: config.logLevel });
  // Each running check holds a connection briefly when it stores its result,
  // so the pool is sized to the concurrency, with a little headroom for the
  // scheduler.
  const db = createDatabaseClient({
    connectionString: config.databaseUrl,
    maxConnections: Math.min(config.concurrency + 2, 50),
  });

  const runtime = startWorkerRuntime({ config, db, probe: createProber(), logger });
  logger.info({ concurrency: config.concurrency }, "worker started");

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

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Failed to start:", error);
  }
  process.exit(1);
}
