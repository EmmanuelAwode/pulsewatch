import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env files itself. Load the repository-level .env
// for local development; in CI and production the variable is already set.
try {
  process.loadEnvFile(path.join(import.meta.dirname, "..", "..", ".env"));
} catch {
  // No .env file: rely on the real environment.
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    // `prisma generate` does not connect to a database, so a missing URL must
    // not stop it. Commands that do connect fail with a clear error instead.
    url: process.env["DATABASE_URL"] ?? "",
  },
});
