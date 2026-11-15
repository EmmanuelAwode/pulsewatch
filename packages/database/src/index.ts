import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";

export interface DatabaseClientOptions {
  /** PostgreSQL connection string. Supplied by the caller, never read from the environment here. */
  connectionString: string;
  /**
   * Maximum connections in this process's pool. Every API and worker process
   * has its own pool, so (processes x maxConnections) must stay below the
   * server's max_connections.
   */
  maxConnections?: number;
}

/**
 * Creates a Prisma client backed by a node-postgres connection pool.
 *
 * This is a factory, not a module-level singleton, on purpose: each process
 * (API, worker, test run) builds its own client from validated configuration
 * and passes it to the code that needs it. Tests can therefore point the same
 * code at a throwaway database without any mocking.
 *
 * The caller owns the client and must call `$disconnect()` on shutdown.
 */
export function createDatabaseClient(options: DatabaseClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    // Pin every connection's session time zone to UTC (ADR-013).
    //
    // PostgreSQL renders a timestamptz as text in the SESSION time zone, e.g.
    // "02:30:00+01" on a server configured for Europe/London. The driver
    // adapter drops that offset when parsing, so on any non-UTC server every
    // timestamp read back is shifted by the server's UTC offset. The stored
    // value is correct; only the read is wrong. Forcing UTC here makes the
    // text and the instant agree regardless of how the server is configured.
    options: "-c timezone=UTC",
  });
  return new PrismaClient({ adapter });
}
