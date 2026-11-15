import { z } from "zod";

/** Every environment variable the worker reads. Validated once at start-up. */
const envSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z
    .string({ error: "is required" })
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string"),
  REDIS_URL: z
    .string({ error: "is required" })
    .regex(/^rediss?:\/\//, "must be a redis:// or rediss:// connection string"),
  WORKER_CONCURRENCY: z.coerce
    .number({ error: "must be a whole number" })
    .int()
    .min(1)
    .max(500)
    .default(20),
  SCHEDULER_TICK_MS: z.coerce
    .number({ error: "must be a whole number of milliseconds" })
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  SCHEDULER_BATCH_SIZE: z.coerce
    .number({ error: "must be a whole number" })
    .int()
    .min(1)
    .max(5_000)
    .default(500),
});

export interface WorkerConfig {
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
  schedulerTickMs: number;
  schedulerBatchSize: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Names the variable and the rule it broke; never echoes the value (it may be a secret). */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const values = parsed.data;
  return {
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL,
    concurrency: values.WORKER_CONCURRENCY,
    schedulerTickMs: values.SCHEDULER_TICK_MS,
    schedulerBatchSize: values.SCHEDULER_BATCH_SIZE,
  };
}
