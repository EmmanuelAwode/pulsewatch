import { randomUUID } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@pulsewatch/database";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
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
import { AppError } from "./errors.js";
import { createEventHub } from "./events/hub.js";
import { eventRoutes } from "./events/routes.js";
import { historyRoutes } from "./history/routes.js";
import { createHistoryService } from "./history/service.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { registerMetrics } from "./http/metrics.js";
import { registerOriginCheck } from "./http/origin-check.js";
import { monitorRoutes } from "./monitors/routes.js";
import { createMonitorService } from "./monitors/service.js";
import { healthRoutes } from "./routes/health.js";
import { settingsRoutes } from "./settings/routes.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** "auth" puts a route under the strict login/registration rate limit. */
    rateLimitTier?: "auth";
  }
}

export interface AppDependencies {
  config: Pick<
    Config,
    "logLevel" | "docsEnabled" | "auth" | "redisUrl" | "rateLimit" | "trustProxy"
  >;
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
    // Behind a reverse proxy, the real client IP is in X-Forwarded-For. Only
    // trusted when configured, since a client can set that header itself.
    trustProxy: config.trustProxy,
  });

  // Two Redis connections: one for commands (rate-limit counters, readiness)
  // and one for the live-event subscription, because a connection in
  // subscriber mode cannot run other commands. The app owns both and closes
  // them when it closes.
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const subscriber = new Redis(config.redisUrl);
  for (const connection of [redis, subscriber]) {
    connection.on("error", (error) => {
      app.log.warn({ err: error }, "redis connection error");
    });
  }
  const hub = createEventHub(subscriber, app.log);
  app.addHook("onClose", async () => {
    hub.close();
    redis.disconnect();
    subscriber.disconnect();
    await Promise.resolve();
  });

  // Zod schemas on routes drive three things at once: request validation,
  // response serialisation and the OpenAPI document. One definition, so the
  // documentation cannot drift from the behaviour.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Fastify's JSON parser rejects an empty body with a 400, but many clients
  // send `Content-Type: application/json` on every request, including POSTs
  // such as /auth/logout that have no body. An empty body is treated as "no
  // body"; anything else goes to Fastify's own parser, which keeps its
  // prototype-poisoning protection ("error" = reject __proto__ and
  // constructor.prototype keys outright). A route that does need a body still
  // rejects the empty one, as a 422 from its schema.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    // With parseAs "string" the body is always a string at runtime; the
    // declared type also allows a Buffer, so normalise rather than cast.
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text === "") {
      done(null, undefined);
      return;
    }
    // The default parser reports its result through `done`. Its declared
    // type also permits a promise, which `void` makes explicit is unused.
    void parseJson(request, text, done);
  });

  registerErrorHandling(app);
  registerOriginCheck(app, config.auth.appOrigin);
  registerMetrics(app);

  // Rate limits (docs/api.md). Counters live in Redis so that a limit holds
  // across every API instance, not per process. If Redis is unreachable the
  // limiter lets requests through (skipOnError): an outage of the limiter
  // should not become an outage of the whole API (ADR-024).
  await app.register(fastifyRateLimit, {
    // Not "global": the plugin would then attach its check AFTER each route's
    // own onRequest hooks, so the authentication guard would reject an
    // unauthenticated request before it was ever counted, leaving protected
    // endpoints unthrottled for anyone without a session. Found by a test.
    global: false,
    redis,
    nameSpace: config.rateLimit.keyPrefix,
    skipOnError: true,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new AppError(429, "RATE_LIMITED", `Too many requests. Try again in ${context.after}.`),
  });
  // Instead, limiting is one app-level hook, which runs before any route's
  // hooks, for every request. The plugin applies at most one limiter per
  // request, so this hook picks it: login and registration get a much
  // stricter limit (and their own counter), routes marked `rateLimit: false`
  // (health probes, metrics, the event stream) are exempt, and everything
  // else shares the general limit.
  const generalLimit = app.rateLimit({
    max: config.rateLimit.perMinute,
    timeWindow: 60_000,
    keyGenerator: (request) => `general:${request.ip}`,
  });
  const authLimit = app.rateLimit({
    max: config.rateLimit.authPerMinute,
    timeWindow: 60_000,
    keyGenerator: (request) => `auth:${request.ip}`,
  });
  app.addHook("onRequest", async (request, reply) => {
    const { rateLimit, rateLimitTier } = request.routeOptions.config;
    if (rateLimit === false) return;
    await (rateLimitTier === "auth" ? authLimit : generalLimit).call(app, request, reply);
  });

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
        { name: "history", description: "Check results, analytics, incidents, dashboard" },
        { name: "settings", description: "Notification preferences" },
        { name: "events", description: "Live updates" },
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

  const history = createHistoryService({ db, now });

  await app.register(healthRoutes, { db, redis });
  await app.register(authRoutes, {
    prefix: "/api/v1/auth",
    auth,
    requireAuth,
    config: config.auth,
  });
  await app.register(monitorRoutes, { prefix: "/api/v1/monitors", monitors, requireAuth });
  await app.register(historyRoutes, { prefix: "/api/v1", history, requireAuth, now });
  await app.register(settingsRoutes, { prefix: "/api/v1/settings", db, requireAuth });
  await app.register(eventRoutes, { prefix: "/api/v1", hub, requireAuth });

  return app;
}
