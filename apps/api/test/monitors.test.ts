import { randomUUID } from "node:crypto";
import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ErrorResponse } from "../src/http/schemas.js";
import { testConfig } from "./helpers.js";

/**
 * Monitor CRUD through the real HTTP stack and a real PostgreSQL.
 * The most important tests here are in "authorisation": they prove one user
 * cannot read, change or delete another user's monitors.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");
const MONITOR_LIMIT = 3;
const BASE = "/api/v1/monitors";

let db: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
  app = await buildApp({
    config: testConfig(),
    db,
    now: () => NOW,
    maxMonitorsPerUser: MONITOR_LIMIT,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

type Cookies = Record<string, string>;

interface MonitorBody {
  id: string;
  name: string;
  url: string;
  paused: boolean;
  status: string;
  intervalSeconds: number;
}

/** Registers a fresh user and returns the cookies that authenticate as them. */
async function signUp(): Promise<{ cookies: Cookies; userId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `user-${randomUUID()}@example.com`, password: "correct horse battery" },
  });
  const access = response.cookies.find((cookie) => cookie.name === "pw_access");
  const userId = response.json<{ data: { user: { id: string } } }>().data.user.id;
  return { cookies: { pw_access: access?.value ?? "" }, userId };
}

function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookies: Cookies,
  payload?: object,
) {
  return app.inject({ method, url, cookies, ...(payload ? { payload } : {}) });
}

async function createMonitor(cookies: Cookies, overrides: object = {}): Promise<MonitorBody> {
  const response = await request("POST", BASE, cookies, {
    name: "Checkout API",
    url: "https://api.example.com/health",
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: MonitorBody }>().data;
}

function one(response: LightMyRequestResponse): MonitorBody {
  return response.json<{ data: MonitorBody }>().data;
}

function many(response: LightMyRequestResponse): MonitorBody[] {
  return response.json<{ data: MonitorBody[] }>().data;
}

function error(response: LightMyRequestResponse): ErrorResponse["error"] {
  return response.json<ErrorResponse>().error;
}

describe("POST /monitors", () => {
  it("creates a monitor with defaults and returns where to find it", async () => {
    const { cookies } = await signUp();

    const response = await request("POST", BASE, cookies, {
      name: "  Checkout API  ",
      url: "https://api.example.com/health",
    });
    const monitor = one(response);

    expect(response.statusCode).toBe(201);
    expect(response.headers["location"]).toBe(`${BASE}/${monitor.id}`);
    expect(monitor).toMatchObject({
      name: "Checkout API",
      url: "https://api.example.com/health",
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      failureThreshold: 3,
      recoveryThreshold: 2,
      paused: false,
      status: "PENDING",
      lastCheckedAt: null,
    });
  });

  it("does not expose internal columns", async () => {
    const { cookies } = await signUp();

    const monitor = await createMonitor(cookies);

    expect(Object.keys(monitor).sort()).toEqual([
      "createdAt",
      "failureThreshold",
      "id",
      "intervalSeconds",
      "lastCheckedAt",
      "method",
      "name",
      "paused",
      "recoveryThreshold",
      "status",
      "timeoutMs",
      "updatedAt",
      "url",
    ]);
  });

  it("assigns the caller as owner and ignores an owner supplied in the body", async () => {
    const victim = await signUp();
    const caller = await signUp();

    const monitor = await createMonitor(caller.cookies, { userId: victim.userId, status: "UP" });
    const stored = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });

    expect(stored.userId).toBe(caller.userId);
    expect(stored.status).toBe("PENDING");
  });

  it("schedules the first check within one interval of now", async () => {
    const { cookies } = await signUp();

    const monitor = await createMonitor(cookies, { intervalSeconds: 300 });
    const stored = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });
    const offsetMs = stored.nextCheckAt.getTime() - NOW.getTime();

    expect(offsetMs).toBeGreaterThanOrEqual(0);
    expect(offsetMs).toBeLessThan(300_000);
  });

  it.each([
    ["a plain-http URL", { url: "http://api.example.com" }, "url"],
    ["a URL with credentials", { url: "https://admin:hunter2@api.example.com" }, "url"],
    ["a non-default port", { url: "https://api.example.com:8443" }, "url"],
    ["something that is not a URL", { url: "not a url" }, "url"],
    ["an empty name", { name: "   " }, "name"],
    ["a name over 100 characters", { name: "x".repeat(101) }, "name"],
    ["an interval under 60 seconds", { intervalSeconds: 59 }, "intervalSeconds"],
    ["a fractional interval", { intervalSeconds: 90.5 }, "intervalSeconds"],
    ["a timeout over 30 seconds", { timeoutMs: 30_001 }, "timeoutMs"],
    ["a method that could change state", { method: "POST" }, "method"],
    ["a zero failure threshold", { failureThreshold: 0 }, "failureThreshold"],
  ])("rejects %s with 422 and names the field", async (_label, overrides, field) => {
    const { cookies, userId } = await signUp();

    const response = await request("POST", BASE, cookies, {
      name: "Checkout API",
      url: "https://api.example.com/health",
      ...overrides,
    });

    expect(response.statusCode).toBe(422);
    expect(error(response).details?.map((detail) => detail.path)).toEqual([field]);
    expect(await db.monitor.count({ where: { userId } })).toBe(0);
  });

  it("rejects a body with missing required fields, naming each", async () => {
    const { cookies } = await signUp();

    const response = await request("POST", BASE, cookies, {});

    expect(response.statusCode).toBe(422);
    expect(
      error(response)
        .details?.map((detail) => detail.path)
        .sort(),
    ).toEqual(["name", "url"]);
  });

  it("refuses to exceed the per-user limit", async () => {
    const { cookies } = await signUp();
    for (let index = 0; index < MONITOR_LIMIT; index += 1) await createMonitor(cookies);

    const response = await request("POST", BASE, cookies, {
      name: "One too many",
      url: "https://api.example.com/health",
    });

    expect(response.statusCode).toBe(409);
    expect(error(response).code).toBe("LIMIT_REACHED");
  });

  it("holds the limit when many creations arrive at once", async () => {
    const { cookies, userId } = await signUp();

    const responses = await Promise.all(
      Array.from({ length: MONITOR_LIMIT + 5 }, (_, index) =>
        request("POST", BASE, cookies, {
          name: `Monitor ${index}`,
          url: "https://api.example.com/health",
        }),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(MONITOR_LIMIT);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(5);
    expect(await db.monitor.count({ where: { userId } })).toBe(MONITOR_LIMIT);
  });

  it("counts each user's monitors separately", async () => {
    const first = await signUp();
    const second = await signUp();
    for (let index = 0; index < MONITOR_LIMIT; index += 1) await createMonitor(first.cookies);

    await createMonitor(second.cookies);
  });
});

describe("GET /monitors", () => {
  it("lists only the caller's monitors, newest first", async () => {
    const owner = await signUp();
    const other = await signUp();
    const older = await createMonitor(owner.cookies, { name: "Older" });
    const newer = await createMonitor(owner.cookies, { name: "Newer" });
    await createMonitor(other.cookies, { name: "Someone else's" });
    // Creation times can tie within a millisecond; make the order explicit.
    await db.monitor.update({
      where: { id: older.id },
      data: { createdAt: new Date("2025-01-01T00:00:00.000Z") },
    });

    const response = await request("GET", BASE, owner.cookies);

    expect(response.statusCode).toBe(200);
    expect(many(response).map((monitor) => monitor.id)).toEqual([newer.id, older.id]);
  });

  it("returns an empty list for a new account", async () => {
    const { cookies } = await signUp();

    expect(many(await request("GET", BASE, cookies))).toEqual([]);
  });
});

describe("GET /monitors/:id", () => {
  it("returns the monitor", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies);

    const response = await request("GET", `${BASE}/${monitor.id}`, cookies);

    expect(response.statusCode).toBe(200);
    expect(one(response)).toEqual(monitor);
  });

  it("returns 404 for an ID that does not exist", async () => {
    const { cookies } = await signUp();

    const response = await request("GET", `${BASE}/${randomUUID()}`, cookies);

    expect(response.statusCode).toBe(404);
    expect(error(response)).toMatchObject({ code: "NOT_FOUND", message: "Monitor not found." });
  });

  it("returns 422 for a malformed ID instead of failing in the database", async () => {
    const { cookies } = await signUp();

    const response = await request("GET", `${BASE}/not-a-uuid`, cookies);

    expect(response.statusCode).toBe(422);
    expect(error(response).details?.[0]?.path).toBe("id");
  });
});

describe("PATCH /monitors/:id", () => {
  it("changes only the fields that were sent", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies, { intervalSeconds: 120 });

    const response = await request("PATCH", `${BASE}/${monitor.id}`, cookies, { name: "Renamed" });

    expect(response.statusCode).toBe(200);
    expect(one(response)).toMatchObject({
      name: "Renamed",
      url: monitor.url,
      intervalSeconds: 120,
    });
  });

  it("pauses and resumes, scheduling a prompt check on resume", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies, { intervalSeconds: 3_600 });
    const url = `${BASE}/${monitor.id}`;

    const paused = await request("PATCH", url, cookies, { paused: true });
    expect(one(paused).paused).toBe(true);

    const resumed = await request("PATCH", url, cookies, { paused: false });
    const stored = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });

    expect(one(resumed).paused).toBe(false);
    expect(stored.nextCheckAt.getTime()).toBe(NOW.getTime());
  });

  it("resets state and closes the open incident when the URL changes", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies);
    await db.monitor.update({
      where: { id: monitor.id },
      data: { status: "DOWN", consecutiveFailures: 5 },
    });
    await db.incident.create({
      data: {
        monitorId: monitor.id,
        startedAt: new Date("2025-12-31T23:00:00.000Z"),
        causeErrorType: "TIMEOUT",
      },
    });

    const response = await request("PATCH", `${BASE}/${monitor.id}`, cookies, {
      url: "https://new.example.com/health",
    });
    const stored = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });
    const incident = await db.incident.findFirstOrThrow({ where: { monitorId: monitor.id } });

    expect(one(response).status).toBe("PENDING");
    expect(stored.consecutiveFailures).toBe(0);
    expect(incident.resolvedAt?.getTime()).toBe(NOW.getTime());
  });

  it("keeps state when a change does not affect the target", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies);
    await db.monitor.update({
      where: { id: monitor.id },
      data: { status: "DOWN", consecutiveFailures: 5 },
    });

    const response = await request("PATCH", `${BASE}/${monitor.id}`, cookies, { name: "Renamed" });

    expect(one(response).status).toBe("DOWN");
  });

  it.each([
    ["an empty body", {}],
    ["an invalid URL", { url: "http://insecure.example.com" }],
    ["an out-of-range interval", { intervalSeconds: 1 }],
  ])("rejects %s with 422 and leaves the monitor unchanged", async (_label, patch) => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies);

    const response = await request("PATCH", `${BASE}/${monitor.id}`, cookies, patch);

    expect(response.statusCode).toBe(422);
    expect(one(await request("GET", `${BASE}/${monitor.id}`, cookies))).toEqual(monitor);
  });

  it("cannot be used to change the owner or the status", async () => {
    const owner = await signUp();
    const other = await signUp();
    const monitor = await createMonitor(owner.cookies);

    await request("PATCH", `${BASE}/${monitor.id}`, owner.cookies, {
      name: "Renamed",
      userId: other.userId,
      status: "UP",
    });
    const stored = await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } });

    expect(stored.userId).toBe(owner.userId);
    expect(stored.status).toBe("PENDING");
  });
});

describe("DELETE /monitors/:id", () => {
  it("deletes the monitor together with its history", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies);
    await db.checkResult.create({
      data: {
        monitorId: monitor.id,
        scheduledFor: NOW,
        checkedAt: NOW,
        success: true,
        statusCode: 200,
        responseTimeMs: 100,
      },
    });

    const response = await request("DELETE", `${BASE}/${monitor.id}`, cookies);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect((await request("GET", `${BASE}/${monitor.id}`, cookies)).statusCode).toBe(404);
    expect(await db.checkResult.count({ where: { monitorId: monitor.id } })).toBe(0);
  });

  it("returns 404 when deleting the same monitor twice", async () => {
    const { cookies } = await signUp();
    const monitor = await createMonitor(cookies);
    await request("DELETE", `${BASE}/${monitor.id}`, cookies);

    expect((await request("DELETE", `${BASE}/${monitor.id}`, cookies)).statusCode).toBe(404);
  });
});

describe("authentication", () => {
  it.each([
    ["GET", BASE],
    ["POST", BASE],
    ["GET", `${BASE}/${randomUUID()}`],
    ["PATCH", `${BASE}/${randomUUID()}`],
    ["DELETE", `${BASE}/${randomUUID()}`],
  ] as const)("%s %s requires a session", async (method, url) => {
    const response = await request(method, url, {}, method === "GET" ? undefined : { name: "x" });

    expect(response.statusCode).toBe(401);
    expect(error(response).code).toBe("UNAUTHENTICATED");
  });
});

describe("authorisation: another user's monitor", () => {
  async function scenario() {
    const owner = await signUp();
    const intruder = await signUp();
    const monitor = await createMonitor(owner.cookies, { name: "Private" });
    return { owner, intruder, monitor, url: `${BASE}/${monitor.id}` };
  }

  it("cannot be read, and looks exactly like a monitor that does not exist", async () => {
    const { intruder, url } = await scenario();

    const forbidden = await request("GET", url, intruder.cookies);
    const missing = await request("GET", `${BASE}/${randomUUID()}`, intruder.cookies);

    expect(forbidden.statusCode).toBe(404);
    // Same status, code and message: the response must not confirm the ID exists.
    const visible = (response: LightMyRequestResponse) => {
      const { code, message, details } = error(response);
      return { code, message, details };
    };
    expect(visible(forbidden)).toEqual(visible(missing));
  });

  it("cannot be updated, and is left unchanged", async () => {
    const { owner, intruder, monitor, url } = await scenario();

    const response = await request("PATCH", url, intruder.cookies, {
      name: "Hijacked",
      url: "https://attacker.example.com",
      paused: true,
    });

    expect(response.statusCode).toBe(404);
    expect(one(await request("GET", url, owner.cookies))).toEqual(monitor);
  });

  it("cannot be deleted", async () => {
    const { owner, intruder, url } = await scenario();

    const response = await request("DELETE", url, intruder.cookies);

    expect(response.statusCode).toBe(404);
    expect((await request("GET", url, owner.cookies)).statusCode).toBe(200);
  });

  it("does not appear in the other user's list", async () => {
    const { intruder } = await scenario();

    expect(many(await request("GET", BASE, intruder.cookies))).toEqual([]);
  });
});
