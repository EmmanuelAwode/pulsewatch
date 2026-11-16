import { DEFAULT_RETENTION_DAYS } from "@pulsewatch/shared";
import { z } from "zod";

const wholeNumber = (min: number, max: number, unit: string) =>
  z.coerce
    .number({ error: `must be a whole number of ${unit}` })
    .int()
    .min(min)
    .max(max);

/** Every environment variable the worker reads. Validated once at start-up. */
const envSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z
    .string({ error: "is required" })
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string"),
  REDIS_URL: z
    .string({ error: "is required" })
    .regex(/^rediss?:\/\//, "must be a redis:// or rediss:// connection string"),
  WORKER_CONCURRENCY: wholeNumber(1, 500, "checks").default(20),
  SCHEDULER_TICK_MS: wholeNumber(100, 60_000, "milliseconds").default(1_000),
  SCHEDULER_BATCH_SIZE: wholeNumber(1, 5_000, "monitors").default(500),
  NOTIFICATION_SWEEP_MS: wholeNumber(1_000, 300_000, "milliseconds").default(15_000),
  // Must cover the longest analytics range (30 days), or that view would
  // silently show less data than it claims.
  RETENTION_DAYS: wholeNumber(DEFAULT_RETENTION_DAYS, 3_650, "days").default(
    DEFAULT_RETENTION_DAYS,
  ),
  // Optional. Without it, alert emails are written to the log instead.
  SMTP_URL: z
    .string()
    .regex(/^smtps?:\/\//, "must be an smtp:// or smtps:// URL")
    .optional(),
  MAIL_FROM: z.string().min(3).default("PulseWatch <alerts@localhost>"),
  // The metrics endpoint is internal; never expose it to the internet.
  METRICS_HOST: z.string().min(1).default("127.0.0.1"),
  METRICS_PORT: wholeNumber(1, 65_535, "port").default(9_100),
});

export interface WorkerConfig {
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
  schedulerTickMs: number;
  schedulerBatchSize: number;
  notificationSweepMs: number;
  retentionDays: number;
  smtpUrl: string | undefined;
  mailFrom: string;
  metricsHost: string;
  metricsPort: number;
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
    notificationSweepMs: values.NOTIFICATION_SWEEP_MS,
    retentionDays: values.RETENTION_DAYS,
    smtpUrl: values.SMTP_URL,
    mailFrom: values.MAIL_FROM,
    metricsHost: values.METRICS_HOST,
    metricsPort: values.METRICS_PORT,
  };
}
