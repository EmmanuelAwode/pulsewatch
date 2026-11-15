import { randomUUID } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@pulsewatch/database";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createAuthGuard } from "./auth/guard.js";
import { authRoutes } from "./auth/routes.js";
import { createAuthService } from "./auth/service.js";
import { createTokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { registerOriginCheck } from "./http/origin-check.js";
import { monitorRoutes } from "./monitors/routes.js";
import { createMonitorService } from "./monitors/service.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDependencies {
  config: Pick<Config, "logLevel" | "docsEnabled" | "auth">;
  db: PrismaClient;
  /** Where log lines are written. Defaults to stdout; tests capture them here. */
  logDestination?: { write: (line: string) => void };
  /** The clock. Defaults to the system clock; tests move it to check expiry. */
  now?: () => Date;
  /** Overrides the per-user monitor limit; tests use a small number. */
  maxMonitorsPerUser?: number;
}

/**
 * Builds the HTTP application without starting it.
 *
 * Keeping "build" separate from "listen" (see server.ts) is what makes the
 * API testable: tests call this with a test database and use Fastify's
 * `inject()` to send requests straight into the router, with no network port
 * and no global state. Everything the app needs arrives through `deps`.
 *
 * This function is also the composition root: the one place where services
 * are constructed and handed their dependencies. No service creates its own
 * database client or reads configuration itself.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, db } = deps;
  const now = deps.now ?? (() => new Date());

  const app = Fastify({
    logger: {
      level: config.logLevel,
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
  registerOriginCheck(app, config.auth.appOrigin);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    await Promise.resolve();
  });

  app.decorateRequest("userId", "");
  await app.register(fastifyCookie);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "PulseWatch API",
        description: "API monitoring platform: monitors, check history, incidents and analytics.",
        version: "0.1.0",
      },
      tags: [
        { name: "auth", description: "Accounts and sessions" },
        { name: "monitors", description: "Endpoints to watch" },
        { name: "operations", description: "Health and readiness probes" },
      ],
    },
    transform: jsonSchemaTransform,
  });

  if (config.docsEnabled) {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  const tokens = createTokenService({
    accessSecret: config.auth.accessSecret,
    accessTtlSeconds: config.auth.accessTtlSeconds,
    now,
  });
  const auth = createAuthService({
    db,
    tokens,
    refreshTtlSeconds: config.auth.refreshTtlSeconds,
    now,
  });
  const requireAuth = createAuthGuard(tokens);
  const monitors = createMonitorService({
    db,
    now,
    ...(deps.maxMonitorsPerUser === undefined
      ? {}
      : { maxMonitorsPerUser: deps.maxMonitorsPerUser }),
  });

  await app.register(healthRoutes, { db });
  await app.register(authRoutes, {
    prefix: "/api/v1/auth",
    auth,
    requireAuth,
    config: config.auth,
  });
  await app.register(monitorRoutes, { prefix: "/api/v1/monitors", monitors, requireAuth });

  return app;
}
