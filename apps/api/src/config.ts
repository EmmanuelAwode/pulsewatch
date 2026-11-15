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

  // HS256 security is bounded by the secret's entropy, so a short secret is
  // refused outright rather than silently accepted.
  JWT_ACCESS_SECRET: z
    .string({ error: "is required" })
    .min(32, "must be at least 32 characters (generate one with: openssl rand -base64 48)"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number({ error: "must be a whole number of seconds" })
    .int()
    .min(60)
    .max(3_600)
    .default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce
    .number({ error: "must be a whole number of days" })
    .int()
    .min(1)
    .max(90)
    .default(7),
  // The one origin the web app is served from; used by the CSRF origin check.
  APP_ORIGIN: z
    .string()
    .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
      error:
        "must be an origin such as https://app.example.com (scheme, host and optional port; no path or trailing slash)",
    })
    .default("http://localhost:5173"),
});

export interface AuthConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Cookies are HTTPS-only in production; development runs on plain HTTP. */
  cookieSecure: boolean;
  appOrigin: string;
}

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  databaseUrl: string;
  /** Interactive API docs are a development aid, so they are off in production. */
  docsEnabled: boolean;
  auth: AuthConfig;
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
  const production = values.NODE_ENV === "production";
  return {
    env: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    docsEnabled: !production,
    auth: {
      accessSecret: values.JWT_ACCESS_SECRET,
      accessTtlSeconds: values.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: values.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
      cookieSecure: production,
      appOrigin: values.APP_ORIGIN,
    },
  };
}
