import type { ServerResponse } from "node:http";
import { EVENTS_CHANNEL, type EventEnvelope } from "@pulsewatch/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

/** Open event streams allowed per user, e.g. several browser tabs. */
export const MAX_STREAMS_PER_USER = 5;

export interface EventHub {
  /** Starts sending this user's events to `response`. Returns a function that stops it. */
  attach: (userId: string, response: ServerResponse) => () => void;
  streamCount: (userId: string) => number;
  /** Ends every open stream. Called when the server shuts down. */
  close: () => void;
}

/**
 * Fans live events out to connected browsers (ADR-006).
 *
 * The worker publishes every event to one Redis channel. Each API instance
 * subscribes once and keeps an in-memory map of which of ITS connections
 * belong to which user, so the worker never needs to know which instance a
 * browser is connected to. That is what lets the API scale horizontally
 * behind a load balancer with no sticky sessions.
 */
export function createEventHub(subscriber: Redis, logger: FastifyBaseLogger): EventHub {
  const streams = new Map<string, Set<ServerResponse>>();

  subscriber.on("message", (channel: string, message: string) => {
    if (channel !== EVENTS_CHANNEL) return;
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(message) as EventEnvelope;
    } catch {
      logger.warn("ignoring malformed live event");
      return;
    }
    const targets = streams.get(envelope.userId);
    if (!targets) return;
    // Server-Sent Events wire format: a named event and a JSON payload.
    const frame = `event: ${envelope.event.type}\ndata: ${JSON.stringify(envelope.event)}\n\n`;
    for (const response of targets) response.write(frame);
  });
  subscriber.subscribe(EVENTS_CHANNEL).catch((error: unknown) => {
    logger.error({ err: error }, "could not subscribe to live events");
  });

  return {
    attach(userId, response) {
      const set = streams.get(userId) ?? new Set();
      set.add(response);
      streams.set(userId, set);
      return () => {
        set.delete(response);
        if (set.size === 0) streams.delete(userId);
      };
    },
    streamCount: (userId) => streams.get(userId)?.size ?? 0,
    close() {
      for (const set of streams.values()) for (const response of set) response.end();
      streams.clear();
    },
  };
}
