import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const DATABASE_URL = "postgresql://app:s3cret-value@db.internal:5432/pulsewatch";
const JWT_ACCESS_SECRET = "a-test-secret-that-is-long-enough-0123456789";
const REDIS_URL = "redis://cache.internal:6379";
const REQUIRED = { DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET };

function problemsFor(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("applies safe defaults when only the required variables are set", () => {
    expect(loadConfig(REQUIRED)).toEqual({
      env: "development",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      trustProxy: false,
      docsEnabled: true,
      auth: {
        accessSecret: JWT_ACCESS_SECRET,
        accessTtlSeconds: 900,
        refreshTtlSeconds: 7 * 24 * 60 * 60,
        cookieSecure: false,
        appOrigin: "http://localhost:5173",
      },
      rateLimit: { perMinute: 300, authPerMinute: 10, keyPrefix: "pulsewatch-rl:" },
    });
  });

  it("marks cookies Secure in production", () => {
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "production" }).auth.cookieSecure).toBe(true);
  });

  it("refuses a JWT secret that is too short to be safe", () => {
    const problems = problemsFor({ DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET: "short-secret" });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^JWT_ACCESS_SECRET: must be at least 32 characters/);
    expect(problems[0]).not.toContain("short-secret");
  });

  it.each(["https://app.example.com/", "https://app.example.com/dashboard", "app.example.com"])(
    "rejects APP_ORIGIN=%s, which is not a bare origin",
    (origin) => {
      const problems = problemsFor({ ...REQUIRED, APP_ORIGIN: origin });

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^APP_ORIGIN: /);
    },
  );

  it("parses PORT from its string form", () => {
    expect(loadConfig({ ...REQUIRED, PORT: "8080" }).port).toBe(8080);
  });

  it("turns the interactive docs off in production", () => {
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "production" }).docsEnabled).toBe(false);
  });

  it("names the missing variable", () => {
    expect(problemsFor({ JWT_ACCESS_SECRET, REDIS_URL })).toEqual(["DATABASE_URL: is required"]);
  });

  it.each(["0", "70000", "abc", "80.5"])("rejects PORT=%s", (port) => {
    const problems = problemsFor({ ...REQUIRED, PORT: port });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^PORT: /);
  });

  it("reports every problem at once rather than only the first", () => {
    const problems = problemsFor({ JWT_ACCESS_SECRET, REDIS_URL, PORT: "abc", LOG_LEVEL: "loud" });

    expect(problems.map((problem) => problem.split(":")[0]).sort()).toEqual([
      "DATABASE_URL",
      "LOG_LEVEL",
      "PORT",
    ]);
  });

  it("never echoes a value in the error, since values can be secrets", () => {
    const secret = "mysql://root:hunter2@db.internal/app";
    let message = "";
    try {
      loadConfig({ JWT_ACCESS_SECRET, REDIS_URL, DATABASE_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("db.internal");
  });

  it("trusts X-Forwarded-For only when explicitly told to", () => {
    expect(loadConfig(REQUIRED).trustProxy).toBe(false);
    expect(loadConfig({ ...REQUIRED, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(problemsFor({ ...REQUIRED, TRUST_PROXY: "yes" })[0]).toMatch(/^TRUST_PROXY: /);
  });
});
