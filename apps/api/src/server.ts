import { createDatabaseClient } from "@pulsewatch/database";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

/** If in-flight requests have not finished by then, exit anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDatabaseClient({ connectionString: config.databaseUrl });
  const app = await buildApp({ config, db });

  /**
   * Graceful shutdown. Orchestrators (Docker, Kubernetes) send SIGTERM before
   * killing a container. `app.close()` stops accepting new connections and
   * waits for in-flight requests, so a deploy does not cut off a request
   * half-way. Only then is the database pool closed.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      app.log.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    app
      .close()
      .then(() => db.$disconnect())
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  // The logger may not exist yet (configuration failed), so write directly.
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Failed to start:", error);
  }
  process.exit(1);
});
