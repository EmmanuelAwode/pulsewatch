import { randomUUID } from "node:crypto";
import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ErrorResponse } from "../src/http/schemas.js";
import { testConfig } from "./helpers.js";

/**
 * History, analytics, incidents, dashboard and settings, through HTTP and a
 * real PostgreSQL. Data is inserted directly with known values so every
 * statistic can be checked against a figure worked out by hand.
 */

const NOW = new Date("2026-03-01T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let db: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
  app = await buildApp({ config: testConfig(), db, now: () => NOW });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

type Cookies = Record<string, string>;

interface Account {
  cookies: Cookies;
  userId: string;
  email: string;
}

async function signUp(): Promise<Account> {
  const email = `user-${randomUUID()}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "correct horse battery" },
  });
  const access = response.cookies.find((cookie) => cookie.name === "pw_access");
  return {
    cookies: { pw_access: access?.value ?? "" },
    userId: response.json<{ data: { user: { id: string } } }>().data.user.id,
    email,
  };
}

/** A monitor that has existed for two days, so the whole 24 h window is covered. */
async function monitorFor(userId: string, name = "Checkout API") {
  return db.monitor.create({
    data: {
      userId,
      name,
      url: "https://api.example.com/health",
      nextCheckAt: NOW,
      createdAt: new Date(NOW.getTime() - 48 * HOUR),
    },
  });
}

/**
 * Ten checks in the last ten minutes: eight successes at 100..800 ms and two
 * timeouts. Plus one success 25 hours ago, outside the 24 h window.
 *
 * Expected, by hand:
 *   uptime  = 8 / 10                         = 80 %
 *   average = (100 + ... + 800) / 8          = 450 ms
 *   median  = (400 + 500) / 2                = 450 ms
 *   p95     = rank 0.95 x (8 - 1) = 6.65
 *             = 700 + 0.65 x (800 - 700)     = 765 ms   (linear interpolation)
 */
async function seedChecks(monitorId: string) {
  const latencies = [100, 200, 300, 400, 500, 600, 700, 800];
  const rows = Array.from({ length: 10 }, (_, index) => {
    const slot = new Date(NOW.getTime() - (index + 1) * MINUTE);
    const latency = latencies[index];
    return latency === undefined
      ? {
          monitorId,
          scheduledFor: slot,
          checkedAt: slot,
          success: false,
          errorType: "TIMEOUT" as const,
          errorMessage: "No response within 10000 ms.",
        }
      : {
          monitorId,
          scheduledFor: slot,
          checkedAt: slot,
          success: true,
          statusCode: 200,
          responseTimeMs: latency,
        };
  });
  const old = new Date(NOW.getTime() - 25 * HOUR);
  rows.push({
    monitorId,
    scheduledFor: old,
    checkedAt: old,
    success: true,
    statusCode: 200,
    responseTimeMs: 5,
  });
  await db.checkResult.createMany({ data: rows });
}

function get(url: string, cookies: Cookies) {
  return app.inject({ method: "GET", url, cookies });
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape it expects the response to have
function data<T>(response: LightMyRequestResponse): T {
  return response.json<{ data: T }>().data;
}

function errorOf(response: LightMyRequestResponse) {
  return response.json<ErrorResponse>().error;
}

interface CheckBody {
  id: string;
  scheduledFor: string;
  success: boolean;
  responseTimeMs: number | null;
}

let owner: Account;
let monitorId: string;

beforeEach(async () => {
  owner = await signUp();
  monitorId = (await monitorFor(owner.userId)).id;
  await seedChecks(monitorId);
});

describe("GET /monitors/:id/analytics", () => {
  interface AnalyticsBody {
    checks: number;
    successful: number;
    failed: number;
    expectedChecks: number;
    uptimePercent: number | null;
    responseTimeMs: { avg: number | null; p50: number | null; p95: number | null };
    series: { bucketStart: string; checks: number; uptimePercent: number | null }[];
  }

  it("computes uptime and latency statistics for the last 24 hours", async () => {
    const response = await get(`/api/v1/monitors/${monitorId}/analytics?range=24h`, owner.cookies);
    const body = data<AnalyticsBody>(response);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      checks: 10,
      successful: 8,
      failed: 2,
      uptimePercent: 80,
      responseTimeMs: { avg: 450, p50: 450, p95: 765 },
    });
  });

  it("reports how many checks the schedule expected, to expose gaps", async () => {
    const body = data<AnalyticsBody>(
      await get(`/api/v1/monitors/${monitorId}/analytics`, owner.cookies),
    );

    // 24 h at one check a minute; only 10 were recorded.
    expect(body.expectedChecks).toBe(1_440);
  });

  it("returns one bucket per hour, including empty ones", async () => {
    const body = data<AnalyticsBody>(
      await get(`/api/v1/monitors/${monitorId}/analytics?range=24h`, owner.cookies),
    );

    expect(body.series).toHaveLength(24);
    expect(body.series[0]).toMatchObject({
      bucketStart: "2026-02-28T12:00:00.000Z",
      checks: 0,
      uptimePercent: null,
    });
    expect(body.series[23]).toMatchObject({
      bucketStart: "2026-03-01T11:00:00.000Z",
      checks: 10,
      uptimePercent: 80,
    });
  });

  it("includes the older check in the 7-day range, with 28 six-hour buckets", async () => {
    const body = data<AnalyticsBody>(
      await get(`/api/v1/monitors/${monitorId}/analytics?range=7d`, owner.cookies),
    );

    expect(body.checks).toBe(11);
    expect(body.series).toHaveLength(28);
  });

  it("returns nulls rather than zeros when there is no data", async () => {
    const empty = await monitorFor(owner.userId, "Empty");

    const body = data<AnalyticsBody>(
      await get(`/api/v1/monitors/${empty.id}/analytics`, owner.cookies),
    );

    expect(body).toMatchObject({
      checks: 0,
      uptimePercent: null,
      responseTimeMs: { avg: null, p50: null, p95: null },
    });
  });

  it("rejects an unknown range", async () => {
    const response = await get(`/api/v1/monitors/${monitorId}/analytics?range=1y`, owner.cookies);

    expect(response.statusCode).toBe(422);
  });
});

describe("GET /monitors/:id/checks", () => {
  it("pages through results newest first without gaps or repeats", async () => {
    const seen: string[] = [];
    let url = `/api/v1/monitors/${monitorId}/checks?limit=4`;
    const pageSizes: number[] = [];

    for (;;) {
      const response = await get(url, owner.cookies);
      const body = response.json<{ data: CheckBody[]; meta: { nextCursor: string | null } }>();
      pageSizes.push(body.data.length);
      seen.push(...body.data.map((check) => check.scheduledFor));
      if (!body.meta.nextCursor) break;
      url = `/api/v1/monitors/${monitorId}/checks?limit=4&cursor=${body.meta.nextCursor}`;
    }

    expect(pageSizes).toEqual([4, 4, 3]);
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect([...seen].sort().reverse()).toEqual(seen);
  });

  it("filters by outcome", async () => {
    const body = data<CheckBody[]>(
      await get(`/api/v1/monitors/${monitorId}/checks?success=false`, owner.cookies),
    );

    expect(body).toHaveLength(2);
    expect(body.every((check) => !check.success && check.responseTimeMs === null)).toBe(true);
  });

  it("rejects a tampered cursor with 422", async () => {
    const response = await get(
      `/api/v1/monitors/${monitorId}/checks?cursor=not-a-real-cursor`,
      owner.cookies,
    );

    expect(response.statusCode).toBe(422);
    expect(errorOf(response).details?.[0]?.path).toBe("cursor");
  });

  it("returns one check in full, with its 64-bit ID as a string", async () => {
    const [first] = data<CheckBody[]>(
      await get(`/api/v1/monitors/${monitorId}/checks?limit=1`, owner.cookies),
    );
    expect(first?.id).toMatch(/^\d+$/);

    const response = await get(`/api/v1/monitors/${monitorId}/checks/${first?.id}`, owner.cookies);

    expect(response.statusCode).toBe(200);
    expect(data<CheckBody>(response).scheduledFor).toBe(first?.scheduledFor);
  });

  it("does not return a check through a different monitor's URL", async () => {
    const [check] = data<CheckBody[]>(
      await get(`/api/v1/monitors/${monitorId}/checks?limit=1`, owner.cookies),
    );
    const other = await monitorFor(owner.userId, "Other");

    const response = await get(`/api/v1/monitors/${other.id}/checks/${check?.id}`, owner.cookies);

    expect(response.statusCode).toBe(404);
  });
});

describe("incidents", () => {
  interface IncidentBody {
    id: string;
    monitorName: string;
    startedAt: string;
    resolvedAt: string | null;
    durationSeconds: number;
    cause: { errorType: string };
  }

  async function seedIncidents() {
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR);
    await db.incident.createMany({
      data: [
        { monitorId, startedAt: at(1), resolvedAt: null, causeErrorType: "TIMEOUT" },
        { monitorId, startedAt: at(5), resolvedAt: at(4.5), causeErrorType: "HTTP_STATUS" },
        // Two incidents starting at the same instant, to exercise the tie-break.
        { monitorId, startedAt: at(10), resolvedAt: at(9), causeErrorType: "DNS" },
        { monitorId, startedAt: at(10), resolvedAt: at(9.5), causeErrorType: "TLS" },
      ],
    });
  }

  it("lists incidents newest first with their durations", async () => {
    await seedIncidents();

    const body = data<IncidentBody[]>(await get("/api/v1/incidents", owner.cookies));

    expect(body).toHaveLength(4);
    expect(body[0]).toMatchObject({
      monitorName: "Checkout API",
      resolvedAt: null,
      durationSeconds: 3_600, // open for an hour so far
      cause: { errorType: "TIMEOUT" },
    });
    expect(body[1]?.durationSeconds).toBe(1_800);
  });

  it("filters open and resolved incidents", async () => {
    await seedIncidents();

    const open = data<IncidentBody[]>(await get("/api/v1/incidents?status=open", owner.cookies));
    const resolved = data<IncidentBody[]>(
      await get("/api/v1/incidents?status=resolved", owner.cookies),
    );

    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(3);
  });

  it("pages correctly through incidents that start at the same instant", async () => {
    await seedIncidents();
    const ids: string[] = [];
    let url = "/api/v1/incidents?limit=1";

    for (;;) {
      const body = (await get(url, owner.cookies)).json<{
        data: IncidentBody[];
        meta: { nextCursor: string | null };
      }>();
      ids.push(...body.data.map((incident) => incident.id));
      if (!body.meta.nextCursor) break;
      url = `/api/v1/incidents?limit=1&cursor=${body.meta.nextCursor}`;
    }

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("lists one monitor's incidents", async () => {
    await seedIncidents();
    const other = await monitorFor(owner.userId, "Other");
    await db.incident.create({
      data: { monitorId: other.id, startedAt: NOW, causeErrorType: "TIMEOUT" },
    });

    const body = data<IncidentBody[]>(
      await get(`/api/v1/monitors/${monitorId}/incidents`, owner.cookies),
    );

    expect(body).toHaveLength(4);
    expect(body.every((incident) => incident.monitorName === "Checkout API")).toBe(true);
  });
});

describe("GET /dashboard", () => {
  interface DashboardBody {
    counts: { total: number; up: number; down: number; pending: number; paused: number };
    openIncidents: number;
    last24h: { checks: number; uptimePercent: number | null; avgResponseMs: number | null };
    monitors: { id: string; uptimePercent24h: number | null; checks24h: number }[];
  }

  it("summarises status, incidents and the last 24 hours", async () => {
    await db.monitor.update({ where: { id: monitorId }, data: { status: "DOWN" } });
    const healthy = await monitorFor(owner.userId, "Healthy");
    await db.monitor.update({ where: { id: healthy.id }, data: { status: "UP" } });
    await db.checkResult.create({
      data: {
        monitorId: healthy.id,
        scheduledFor: new Date(NOW.getTime() - MINUTE),
        checkedAt: NOW,
        success: true,
        statusCode: 200,
        responseTimeMs: 1_350,
      },
    });
    const paused = await monitorFor(owner.userId, "Paused");
    await db.monitor.update({ where: { id: paused.id }, data: { paused: true, status: "UP" } });
    await db.incident.create({ data: { monitorId, startedAt: NOW, causeErrorType: "TIMEOUT" } });

    const body = data<DashboardBody>(await get("/api/v1/dashboard", owner.cookies));

    expect(body.counts).toEqual({ total: 3, up: 1, down: 1, pending: 0, paused: 1 });
    expect(body.openIncidents).toBe(1);
    // 11 checks in 24 h, 9 successful; latency weighted by successful checks:
    // (450 x 8 + 1350) / 9 = 550.
    expect(body.last24h).toEqual({ checks: 11, uptimePercent: 81.818, avgResponseMs: 550 });
    expect(body.monitors.find((monitor) => monitor.id === monitorId)).toMatchObject({
      checks24h: 10,
      uptimePercent24h: 80,
    });
    expect(body.monitors.find((monitor) => monitor.id === paused.id)).toMatchObject({
      checks24h: 0,
      uptimePercent24h: null,
    });
  });
});

describe("notification settings", () => {
  it("returns opt-in defaults and the account email", async () => {
    const body = data<object>(await get("/api/v1/settings/notifications", owner.cookies));

    expect(body).toEqual({
      emailEnabled: false,
      notifyOnDown: true,
      notifyOnRecovery: true,
      email: owner.email,
    });
  });

  it("saves and returns new preferences", async () => {
    const preferences = { emailEnabled: true, notifyOnDown: true, notifyOnRecovery: false };

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/notifications",
      cookies: owner.cookies,
      payload: preferences,
    });
    const reread = data<object>(await get("/api/v1/settings/notifications", owner.cookies));

    expect(response.statusCode).toBe(200);
    expect(reread).toEqual({ ...preferences, email: owner.email });
  });

  it("rejects an incomplete body", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/notifications",
      cookies: owner.cookies,
      payload: { emailEnabled: true },
    });

    expect(response.statusCode).toBe(422);
  });
});

describe("authorisation", () => {
  it.each(["/checks", "/checks/1", "/analytics", "/incidents"])(
    "hides another user's monitor %s with a 404",
    async (path) => {
      const intruder = await signUp();

      const response = await get(`/api/v1/monitors/${monitorId}${path}`, intruder.cookies);

      expect(response.statusCode).toBe(404);
    },
  );

  it("never includes another user's incidents or monitors", async () => {
    await db.incident.create({ data: { monitorId, startedAt: NOW, causeErrorType: "TIMEOUT" } });
    const intruder = await signUp();

    const incidents = data<unknown[]>(await get("/api/v1/incidents", intruder.cookies));
    const dashboard = data<{ monitors: unknown[]; openIncidents: number }>(
      await get("/api/v1/dashboard", intruder.cookies),
    );

    expect(incidents).toEqual([]);
    expect(dashboard).toMatchObject({ monitors: [], openIncidents: 0 });
  });

  it.each(["/api/v1/dashboard", "/api/v1/incidents", "/api/v1/settings/notifications"])(
    "%s requires a session",
    async (url) => {
      expect((await get(url, {})).statusCode).toBe(401);
    },
  );
});
