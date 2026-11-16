import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const REQUIRED = {
  DATABASE_URL: "postgresql://app:s3cret@db.internal:5432/pulsewatch",
  REDIS_URL: "redis://cache.internal:6379",
};

function problemsFor(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("worker loadConfig", () => {
  it("applies defaults when only the required variables are set", () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      concurrency: 20,
      schedulerTickMs: 1_000,
      retentionDays: 30,
      smtpUrl: undefined,
      metricsHost: "127.0.0.1",
      metricsPort: 9_100,
    });
  });

  it("treats an empty SMTP_URL as not set, as Compose passes it", () => {
    expect(loadConfig({ ...REQUIRED, SMTP_URL: "" }).smtpUrl).toBeUndefined();
  });

  it("accepts an SMTP URL and rejects anything else", () => {
    expect(loadConfig({ ...REQUIRED, SMTP_URL: "smtps://u:p@mail.example.com:465" }).smtpUrl).toBe(
      "smtps://u:p@mail.example.com:465",
    );
    expect(problemsFor({ ...REQUIRED, SMTP_URL: "http://mail.example.com" })).toEqual([
      "SMTP_URL: must be an smtp:// or smtps:// URL",
    ]);
  });

  it("refuses a retention period shorter than the longest analytics range", () => {
    expect(problemsFor({ ...REQUIRED, RETENTION_DAYS: "7" })).toEqual([
      "RETENTION_DAYS: must be a whole number of days from 30 to 3650",
    ]);
  });

  it("states the allowed range when a number is out of bounds", () => {
    expect(problemsFor({ ...REQUIRED, WORKER_CONCURRENCY: "1000" })).toEqual([
      "WORKER_CONCURRENCY: must be a whole number of checks from 1 to 500",
    ]);
  });

  it("names every missing required variable without echoing values", () => {
    const problems = problemsFor({ SMTP_URL: "smtps://user:hunter2@mail.example.com" });

    expect(problems.map((problem) => problem.split(":")[0]).sort()).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
    ]);
    expect(problems.join(" ")).not.toContain("hunter2");
  });
});
