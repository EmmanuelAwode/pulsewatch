import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const DATABASE_URL = "postgresql://app:s3cret-value@db.internal:5432/pulsewatch";

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
    expect(loadConfig({ DATABASE_URL })).toEqual({
      env: "development",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      databaseUrl: DATABASE_URL,
      docsEnabled: true,
    });
  });

  it("parses PORT from its string form", () => {
    expect(loadConfig({ DATABASE_URL, PORT: "8080" }).port).toBe(8080);
  });

  it("turns the interactive docs off in production", () => {
    expect(loadConfig({ DATABASE_URL, NODE_ENV: "production" }).docsEnabled).toBe(false);
  });

  it("names the missing variable", () => {
    expect(problemsFor({})).toEqual(["DATABASE_URL: is required"]);
  });

  it.each(["0", "70000", "abc", "80.5"])("rejects PORT=%s", (port) => {
    const problems = problemsFor({ DATABASE_URL, PORT: port });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^PORT: /);
  });

  it("reports every problem at once rather than only the first", () => {
    const problems = problemsFor({ PORT: "abc", LOG_LEVEL: "loud" });

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
      loadConfig({ DATABASE_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("db.internal");
  });
});
