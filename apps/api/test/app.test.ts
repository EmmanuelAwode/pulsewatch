import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { notFound } from "../src/errors.js";
import { dataEnvelope, type ErrorResponse } from "../src/http/schemas.js";

/**
 * Requests are sent with Fastify's `inject()`: they go through the real
 * router, hooks, validation, serialisation and error handler, but no network
 * socket is opened. The database is a real PostgreSQL.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_DETAIL = "postgresql://admin:hunter2@10.0.0.5/internal";

let db: PrismaClient;
let app: FastifyInstance;
const logLines: string[] = [];

/** Routes that exist only in this test file, to trigger each error path. */
function registerProbeRoutes(instance: FastifyInstance): void {
  const typed = instance.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/probe/validate",
    {
      schema: {
        body: z.object({ name: z.string().min(1), intervalSeconds: z.number().int().min(60) }),
      },
    },
    (request) => ({ data: request.body }),
  );

  typed.get("/probe/app-error", () => {
    throw notFound("Monitor not found.");
  });

  typed.get("/probe/crash", () => {
    throw new Error(`connection failed: ${SECRET_DETAIL}`);
  });

  typed.get(
    "/probe/user",
    {
      schema: { response: { 200: dataEnvelope(z.object({ id: z.string(), email: z.string() })) } },
    },
    () => ({
      // Simulates a handler that carelessly returns a whole database row.
      data: { id: "u1", email: "a@example.com", passwordHash: "$argon2id$secret" },
    }),
  );
}

beforeAll(async () => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
  app = await buildApp({
    config: { logLevel: "info", docsEnabled: true },
    db,
    logDestination: { write: (line) => logLines.push(line) },
  });
  registerProbeRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

function errorOf(body: string): ErrorResponse["error"] {
  return (JSON.parse(body) as ErrorResponse).error;
}

describe("health", () => {
  it("GET /healthz reports the process is alive", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: "ok" } });
  });

  it("GET /readyz reports ready when the database answers", async () => {
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: "ready", checks: { database: "ok" } } });
  });

  it("GET /readyz returns 503 when the database is unreachable, without leaking why", async () => {
    // Nothing listens on port 1, so the connection is refused immediately.
    const deadDb = createDatabaseClient({
      connectionString: "postgresql://admin:hunter2@127.0.0.1:1/internal",
    });
    const isolated = await buildApp({
      config: { logLevel: "silent", docsEnabled: false },
      db: deadDb,
    });

    try {
      const live = await isolated.inject({ method: "GET", url: "/healthz" });
      const ready = await isolated.inject({ method: "GET", url: "/readyz" });

      // Liveness must stay green: restarting the process would not fix the database.
      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(errorOf(ready.body)).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        details: [{ path: "database", message: "unreachable" }],
      });
      expect(ready.body).not.toContain("hunter2");
      expect(ready.body).not.toContain("127.0.0.1");
    } finally {
      await isolated.close();
      await deadDb.$disconnect();
    }
  });
});

describe("error handling", () => {
  it("returns the standard envelope for an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/no/such/route" });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body)).toEqual({
      code: "NOT_FOUND",
      message: "Route not found.",
      requestId: expect.stringMatching(UUID) as string,
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/probe/validate",
      headers: { "content-type": "application/json" },
      payload: '{"name": ',
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).code).toBe("BAD_REQUEST");
  });

  it("returns 422 with one detail per invalid field", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/probe/validate",
      payload: { name: "", intervalSeconds: 30 },
    });

    expect(response.statusCode).toBe(422);
    const error = errorOf(response.body);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details?.map((detail) => detail.path).sort()).toEqual(["intervalSeconds", "name"]);
  });

  it("accepts a valid body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/probe/validate",
      payload: { name: "Checkout API", intervalSeconds: 60 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { name: "Checkout API", intervalSeconds: 60 } });
  });

  it("returns 413 for a body over the size limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/probe/validate",
      payload: { name: "x".repeat(200 * 1024), intervalSeconds: 60 },
    });

    expect(response.statusCode).toBe(413);
    expect(errorOf(response.body).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("passes through the status, code and message of a deliberate AppError", async () => {
    const response = await app.inject({ method: "GET", url: "/probe/app-error" });

    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body)).toMatchObject({
      code: "NOT_FOUND",
      message: "Monitor not found.",
    });
  });

  it("hides the details of an unexpected error from the client", async () => {
    const response = await app.inject({ method: "GET", url: "/probe/crash" });

    expect(response.statusCode).toBe(500);
    expect(errorOf(response.body)).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("10.0.0.5");
    expect(response.body).not.toContain("stack");
  });

  it("logs the unexpected error in full, tied to the request ID the client received", async () => {
    const response = await app.inject({ method: "GET", url: "/probe/crash" });
    const { requestId } = errorOf(response.body);

    const entry = logLines
      .map((line) => JSON.parse(line) as { reqId?: string; msg?: string; err?: { stack?: string } })
      .find((line) => line.reqId === requestId && line.msg === "unhandled error");

    expect(entry).toBeDefined();
    expect(entry?.err?.stack).toContain("connection failed");
    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("ignores a client-supplied request ID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "attacker-chosen" },
    });

    expect(response.headers["x-request-id"]).toMatch(UUID);
  });
});

describe("response serialisation", () => {
  it("strips fields that are not in the response schema", async () => {
    const response = await app.inject({ method: "GET", url: "/probe/user" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { id: "u1", email: "a@example.com" } });
    expect(response.body).not.toContain("passwordHash");
  });
});

describe("OpenAPI", () => {
  it("serves a document generated from the route schemas", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    const document = response.json<{
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    }>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("PulseWatch API");
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
  });

  it("is not served when docs are disabled", async () => {
    const isolated = await buildApp({ config: { logLevel: "silent", docsEnabled: false }, db });

    try {
      const response = await isolated.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(404);
    } finally {
      await isolated.close();
    }
  });
});
