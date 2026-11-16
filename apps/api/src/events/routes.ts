import type { FastifyPluginAsync } from "fastify";
import type { AuthGuard } from "../auth/guard.js";
import { AppError } from "../errors.js";
import { MAX_STREAMS_PER_USER, type EventHub } from "./hub.js";

interface EventRouteOptions {
  hub: EventHub;
  requireAuth: AuthGuard;
}

/** Proxies close idle connections after ~60 s; a comment line every 25 s keeps it open. */
const HEARTBEAT_MS = 25_000;

export const eventRoutes: FastifyPluginAsync<EventRouteOptions> = async (app, options) => {
  const { hub, requireAuth } = options;

  app.get(
    "/events",
    {
      onRequest: requireAuth,
      // A stream is one long request; counting it against the per-minute
      // limit makes no sense. The per-user stream cap below bounds it instead.
      config: { rateLimit: false },
      schema: {
        tags: ["events"],
        summary: "Live updates (Server-Sent Events)",
        description:
          "A text/event-stream of `check.completed`, `monitor.status_changed`, `incident.opened` and `incident.resolved` events for your monitors. Events are hints to refetch; a missed event never loses data.",
      },
    },
    (request, reply) => {
      if (hub.streamCount(request.userId) >= MAX_STREAMS_PER_USER) {
        throw new AppError(429, "RATE_LIMITED", "Too many open event streams.");
      }

      // From here on Fastify no longer manages the response: it stays open
      // and this handler writes to the socket directly.
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Stops nginx buffering the stream, which would delay every event.
        "x-accel-buffering": "no",
        "x-request-id": request.id,
      });
      // "retry" tells EventSource how long to wait before reconnecting.
      response.write("retry: 5000\n: connected\n\n");

      const detach = hub.attach(request.userId, response);
      const heartbeat = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        detach();
      });
    },
  );

  await Promise.resolve();
};
