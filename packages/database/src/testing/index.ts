import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);

/** Root of the @pulsewatch/database package (works from both src/ and dist/). */
const PACKAGE_ROOT = path.join(import.meta.dirname, "..", "..");

export interface TestDatabase {
  /** Connection string of a freshly migrated, empty database. */
  url: string;
  /** Drops the database and stops the container, if one was started. */
  teardown: () => Promise<void>;
}

/**
 * Provisions a real PostgreSQL database for an integration-test run.
 *
 * Where the server comes from:
 *   - TEST_DATABASE_URL set: that server is used (the role must be allowed to
 *     CREATE DATABASE). Handy on machines without Docker.
 *   - otherwise: a throwaway `postgres:16-alpine` container is started with
 *     Testcontainers. This is what CI does.
 *
 * Either way a new, uniquely named database is created and the real
 * migrations are applied with `prisma migrate deploy`. Tests never touch a
 * developer's own data, never see leftovers from an earlier run, and exercise
 * the same migration path production uses.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const server = await resolveServer();
  const databaseName = `pulsewatch_test_${randomBytes(6).toString("hex")}`;

  try {
    await runAdminStatement(server.adminUrl, `CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    await server.stop();
    throw error;
  }

  const url = withDatabase(server.adminUrl, databaseName);
  const teardown = async (): Promise<void> => {
    // FORCE disconnects any pool a test forgot to close, so teardown cannot hang.
    await runAdminStatement(
      server.adminUrl,
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    await server.stop();
  };

  try {
    await applyMigrations(url);
  } catch (error) {
    await teardown();
    throw error;
  }

  return { url, teardown };
}

interface Server {
  adminUrl: string;
  stop: () => Promise<void>;
}

async function resolveServer(): Promise<Server> {
  const existing = process.env["TEST_DATABASE_URL"];
  if (existing) {
    return { adminUrl: existing, stop: () => Promise.resolve() };
  }

  // Imported lazily so that Docker is only required when it is actually used.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  return {
    adminUrl: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

async function runAdminStatement(adminUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  // Run the Prisma CLI through the current Node binary rather than a `.cmd`
  // shim, so this behaves the same on Windows, macOS and Linux.
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
