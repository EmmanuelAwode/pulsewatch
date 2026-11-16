import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import { EVENTS_CHANNEL, type EventEnvelope } from "@pulsewatch/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ErrorResponse } from "../src/http/schemas.js";
import { testConfig } from "./helpers.js";

/** Rate limiting, Prometheus metrics and the live event stream. */

let db: PrismaClient;
const apps: FastifyInstance[] = [];

beforeAll(() => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

afterAll(async () => {
  await db.$disconnect();
});

async function startApp(rateLimit?: { perMinute: number; authPerMinute: number }) {
  const base = testConfig();
  const app = await buildApp({
    config: { ...base, rateLimit: { ...base.rateLimit, ...rateLimit } },
    db,
  });
  apps.push(app);
  await app.ready();
  return app;
}

async function signUp(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `user-${randomUUID()}@example.com`, password: "correct horse battery" },
  });
  return {
    cookie: `pw_access=${response.cookies.find((cookie) => cookie.name === "pw_access")?.value ?? ""}`,
    userId: response.json<{ data: { user: { id: string } } }>().data.user.id,
  };
}

describe("rate limiting", () => {
  const login = (app: FastifyInstance, remoteAddress = "203.0.113.10") =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress,
      payload: { email: "nobody@example.com", password: "wrong-password" },
    });

  it("limits login attempts per IP and says when to retry", async () => {
    const app = await startApp({ perMinute: 1_000, authPerMinute: 3 });

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await login(app)).statusCode);
    const limited = await login(app);

    expect(statuses).toEqual([401, 401, 401, 429]);
    expect(limited.json<ErrorResponse>().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts each IP separately", async () => {
    const app = await startApp({ perMinute: 1_000, authPerMinute: 2 });
    await login(app, "203.0.113.20");
    await login(app, "203.0.113.20");

    expect((await login(app, "203.0.113.20")).statusCode).toBe(429);
    expect((await login(app, "203.0.113.21")).statusCode).toBe(401);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted, so it cannot be used to dodge limits", async () => {
    const app = await startApp({ perMinute: 1_000, authPerMinute: 2 });
    const spoofed = (forwardedFor: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "203.0.113.30",
        headers: { "x-forwarded-for": forwardedFor },
        payload: { email: "nobody@example.com", password: "wrong-password" },
      });

    await spoofed("198.51.100.1");
    await spoofed("198.51.100.2");

    expect((await spoofed("198.51.100.3")).statusCode).toBe(429);
  });

  it("applies the general limit to other endpoints but never to health probes", async () => {
    const app = await startApp({ perMinute: 3, authPerMinute: 1_000 });
    const me = () =>
      app.inject({ method: "GET", url: "/api/v1/auth/me", remoteAddress: "203.0.113.40" });

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await me()).statusCode);
    const probes = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({ method: "GET", url: "/healthz", remoteAddress: "203.0.113.40" }),
      ),
    );

    expect(statuses).toEqual([401, 401, 401, 429]);
    expect(probes.every((probe) => probe.statusCode === 200)).toBe(true);
  });

  it("holds across two API instances, because the counters live in Redis", async () => {
    const base = testConfig();
    const shared = {
      ...base,
      rateLimit: { ...base.rateLimit, perMinute: 1_000, authPerMinute: 2 },
    };
    const first = await buildApp({ config: shared, db });
    const second = await buildApp({ config: shared, db });
    apps.push(first, second);

    await login(first, "203.0.113.50");
    await login(second, "203.0.113.50");

    expect((await login(first, "203.0.113.50")).statusCode).toBe(429);
  });
});

describe("GET /metrics", () => {
  it("exposes request durations labelled by route pattern, never by raw URL", async () => {
    const app = await startApp();
    const id = randomUUID();
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: `/api/v1/monitors/${id}` });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain('route="/healthz"');
    expect(response.body).toContain('route="/api/v1/monitors/:id"');
    // One series per ID would grow without bound.
    expect(response.body).not.toContain(id);
  });

  it("is left out of the public API documentation", async () => {
    const app = await startApp();
    const document = (await app.inject({ method: "GET", url: "/docs/json" })).json<{
      paths: Record<string, unknown>;
    }>();

    expect(Object.keys(document.paths)).not.toContain("/metrics");
  });
});

describe("GET /events (Server-Sent Events)", () => {
  let publisher: Redis;

  beforeAll(() => {
    publisher = new Redis(inject("redisUrl"));
  });

  afterAll(() => {
    publisher.disconnect();
  });

  async function listening(app: FastifyInstance): Promise<number> {
    await app.listen({ port: 0, host: "127.0.0.1" });
    return (app.server.address() as AddressInfo).port;
  }

  /** Opens a stream and collects what arrives. */
  function openStream(port: number, cookie: string) {
    const chunks: string[] = [];
    let response: IncomingMessage | undefined;
    const ready = new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port, path: "/api/v1/events", headers: { cookie } },
        (incoming) => {
          response = incoming;
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => chunks.push(chunk));
          resolve(incoming);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    return {
      ready,
      text: () => chunks.join(""),
      close: () => response?.destroy(),
    };
  }

  async function waitForText(stream: { text: () => string }, needle: string) {
    const deadline = Date.now() + 5_000;
    while (!stream.text().includes(needle)) {
      if (Date.now() > deadline) throw new Error(`stream never contained ${needle}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function publish(envelope: EventEnvelope) {
    return publisher.publish(EVENTS_CHANNEL, JSON.stringify(envelope));
  }

  it("delivers the user's own events and nobody else's", async () => {
    const app = await startApp();
    const port = await listening(app);
    const alice = await signUp(app);
    const bob = await signUp(app);
    const stream = openStream(port, alice.cookie);
    const response = await stream.ready;
    await waitForText(stream, ": connected");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const monitorId = randomUUID();
    await publish({
      userId: bob.userId,
      event: { type: "incident.opened", monitorId, incidentId: randomUUID() },
    });
    await publish({
      userId: alice.userId,
      event: {
        type: "check.completed",
        monitorId,
        success: true,
        scheduledFor: "2026-01-01T00:00:00.000Z",
      },
    });
    await waitForText(stream, "event: check.completed");
    stream.close();

    expect(stream.text()).toContain(`"monitorId":"${monitorId}"`);
    expect(stream.text()).not.toContain("incident.opened");
  });

  it("rejects an unauthenticated stream", async () => {
    const app = await startApp();

    expect((await app.inject({ method: "GET", url: "/api/v1/events" })).statusCode).toBe(401);
  });

  it("caps the number of open streams per user", async () => {
    const app = await startApp();
    const port = await listening(app);
    const user = await signUp(app);
    const streams = Array.from({ length: 5 }, () => openStream(port, user.cookie));
    await Promise.all(streams.map((stream) => stream.ready));

    const sixth = openStream(port, user.cookie);
    const response = await sixth.ready;

    expect(response.statusCode).toBe(429);
    for (const stream of [...streams, sixth]) stream.close();
  });
});
