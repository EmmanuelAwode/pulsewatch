import { z } from "zod";

/**
 * Every environment variable the API reads, in one place.
 *
 * Validating at start-up means a missing or malformed setting stops the
 * process immediately with a clear message, instead of surfacing later as a
 * confusing runtime error on the first request that happens to need it.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce
    .number({ error: "must be a whole number between 1 and 65535" })
    .int()
    .min(1)
    .max(65_535)
    .default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z
    .string({ error: "is required" })
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string"),
});

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  databaseUrl: string;
  /** Interactive API docs are a development aid, so they are off in production. */
  docsEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Builds the typed configuration from an environment object.
 *
 * Takes the environment as an argument (rather than reading `process.env`
 * directly) so tests can pass any combination of values.
 *
 * Error messages name the variable and the rule it broke but never echo the
 * value, because the value may be a secret and start-up errors end up in logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const values = parsed.data;
  return {
    env: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    docsEnabled: values.NODE_ENV !== "production",
  };
}
