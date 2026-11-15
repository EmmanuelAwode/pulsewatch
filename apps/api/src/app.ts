import { randomUUID } from "node:crypto";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@pulsewatch/database";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDependencies {
  config: Pick<Config, "logLevel" | "docsEnabled">;
  db: PrismaClient;
  /** Where log lines are written. Defaults to stdout; tests capture them here. */
  logDestination?: { write: (line: string) => void };
}

/**
 * Builds the HTTP application without starting it.
 *
 * Keeping "build" separate from "listen" (see server.ts) is what makes the
 * API testable: tests call this with a test database and use Fastify's
 * `inject()` to send requests straight into the router, with no network port
 * and no global state. Everything the app needs arrives through `deps`.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      // Structured JSON logs. Credentials must never be written to them.
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
      ...(deps.logDestination ? { stream: deps.logDestination } : {}),
    },
    // Every request gets a server-generated ID that appears in each log line
    // for that request and in any error response. A client-supplied ID is not
    // trusted, since it would let a caller forge or collide log entries.
    genReqId: () => randomUUID(),
    // Reject bodies over 100 KB before parsing; no endpoint needs more.
    bodyLimit: 100 * 1024,
  });

  // Zod schemas on routes drive three things at once: request validation,
  // response serialisation and the OpenAPI document. One definition, so the
  // documentation cannot drift from the behaviour.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandling(app);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    await Promise.resolve();
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "PulseWatch API",
        description: "API monitoring platform: monitors, check history, incidents and analytics.",
        version: "0.1.0",
      },
      tags: [{ name: "operations", description: "Health and readiness probes" }],
    },
    transform: jsonSchemaTransform,
  });

  if (deps.config.docsEnabled) {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  await app.register(healthRoutes, { db: deps.db });

  return app;
}
