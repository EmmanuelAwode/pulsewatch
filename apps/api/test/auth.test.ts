import { randomUUID } from "node:crypto";
import { createDatabaseClient, type PrismaClient } from "@pulsewatch/database";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ErrorResponse } from "../src/http/schemas.js";
import { APP_ORIGIN, TEST_ACCESS_SECRET, testConfig } from "./helpers.js";

/**
 * End-to-end authentication tests: real HTTP routing (via inject), real
 * Argon2 hashing, real JWT signing, real PostgreSQL. Only the clock is
 * controlled, so expiry can be tested without sleeping.
 */

const PASSWORD = "correct horse battery staple";
const START = new Date("2026-01-01T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let db: PrismaClient;
let app: FastifyInstance;
let currentTime = START;

beforeAll(async () => {
  db = createDatabaseClient({ connectionString: inject("databaseUrl") });
  app = await buildApp({ config: testConfig(), db, now: () => currentTime });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

beforeEach(() => {
  currentTime = START;
});

function advanceClock(ms: number): void {
  currentTime = new Date(currentTime.getTime() + ms);
}

/** A unique email per test, so tests never collide and need no clean-up. */
function newEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

type Cookies = Record<string, string>;

function post(url: string, payload?: object, cookies: Cookies = {}) {
  return app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });
}

function getMe(cookies: Cookies) {
  return app.inject({ method: "GET", url: "/api/v1/auth/me", cookies });
}

function cookie(response: LightMyRequestResponse, name: string) {
  return response.cookies.find((candidate) => candidate.name === name);
}

/** The cookies a browser would hold after this response. */
function sessionCookies(response: LightMyRequestResponse): Cookies {
  return {
    pw_access: cookie(response, "pw_access")?.value ?? "",
    pw_refresh: cookie(response, "pw_refresh")?.value ?? "",
  };
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json<ErrorResponse>().error.code;
}

async function register(email = newEmail()) {
  const response = await post("/api/v1/auth/register", { email, password: PASSWORD });
  expect(response.statusCode).toBe(201);
  return { email, response, cookies: sessionCookies(response) };
}

describe("POST /auth/register", () => {
  it("creates the account and returns only public user fields", async () => {
    const { email, response } = await register();
    const body = response.json<{ data: { user: Record<string, unknown> } }>();

    expect(Object.keys(body.data.user).sort()).toEqual(["createdAt", "email", "id"]);
    expect(body.data.user["email"]).toBe(email);
    // No token and no hash anywhere in the body.
    expect(response.body).not.toMatch(/argon2|token|password/i);
  });

  it("stores an Argon2id hash, never the password", async () => {
    const { email } = await register();
    const stored = await db.user.findUniqueOrThrow({ where: { email } });

    expect(stored.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  it("sets both tokens as HttpOnly, Secure, SameSite cookies with scoped paths", async () => {
    const { response } = await register();

    expect(cookie(response, "pw_access")).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 900,
    });
    expect(cookie(response, "pw_refresh")).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/api/v1/auth",
      maxAge: 7 * 24 * 60 * 60,
    });
  });

  it("stores only a hash of the refresh token", async () => {
    const { email, cookies } = await register();
    const rows = await db.refreshToken.findMany({ where: { user: { email } } });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.tokenHash).not.toBe(cookies["pw_refresh"]);
  });

  it("treats differently-cased emails as the same account", async () => {
    const email = newEmail();
    await register(email);

    const response = await post("/api/v1/auth/register", {
      email: `  ${email.toUpperCase()} `,
      password: PASSWORD,
    });

    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe("CONFLICT");
  });

  it("creates exactly one account when the same email registers twice at once", async () => {
    const email = newEmail();

    const responses = await Promise.all([
      post("/api/v1/auth/register", { email, password: PASSWORD }),
      post("/api/v1/auth/register", { email, password: PASSWORD }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(await db.user.count({ where: { email } })).toBe(1);
  });

  it.each([
    ["an invalid email", { email: "not-an-email", password: PASSWORD }, "email"],
    ["a short password", { email: "a@example.com", password: "short" }, "password"],
    ["an over-long password", { email: "a@example.com", password: "x".repeat(129) }, "password"],
  ])("rejects %s with 422", async (_label, payload, field) => {
    const response = await post("/api/v1/auth/register", payload);
    const { error } = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(422);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details?.map((detail) => detail.path)).toEqual([field]);
    expect(response.cookies).toHaveLength(0);
  });
});

describe("POST /auth/login", () => {
  it("starts a session with the correct password", async () => {
    const { email } = await register();

    const response = await post("/api/v1/auth/login", { email, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect((await getMe(sessionCookies(response))).statusCode).toBe(200);
  });

  it("gives an identical response for a wrong password and an unknown email", async () => {
    const { email } = await register();

    const wrongPassword = await post("/api/v1/auth/login", { email, password: "wrong-password" });
    const unknownEmail = await post("/api/v1/auth/login", {
      email: newEmail(),
      password: "wrong-password",
    });

    // Nothing in either response may hint at whether the account exists.
    const withoutRequestId = (response: LightMyRequestResponse) => {
      const { code, message, details } = response.json<ErrorResponse>().error;
      return { status: response.statusCode, code, message, details };
    };
    expect(withoutRequestId(wrongPassword)).toEqual(withoutRequestId(unknownEmail));
    expect(withoutRequestId(wrongPassword)).toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
    expect(wrongPassword.cookies).toHaveLength(0);
    expect(unknownEmail.cookies).toHaveLength(0);
  });
});

describe("GET /auth/me", () => {
  it("returns the current user", async () => {
    const { email, cookies } = await register();

    const response = await getMe(cookies);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { user: { email: string } } }>().data.user.email).toBe(email);
  });

  it("rejects a request with no cookie", async () => {
    const response = await getMe({});

    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe("UNAUTHENTICATED");
  });

  it("accepts a token just before it expires and rejects it just after", async () => {
    const { cookies } = await register();

    advanceClock(14 * MINUTE);
    expect((await getMe(cookies)).statusCode).toBe(200);

    advanceClock(2 * MINUTE);
    expect((await getMe(cookies)).statusCode).toBe(401);
  });

  it("rejects a token whose payload was altered", async () => {
    const { cookies } = await register();
    const [header, , signature] = (cookies["pw_access"] ?? "").split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: randomUUID(), iss: "pulsewatch", aud: "pulsewatch-api" }),
    ).toString("base64url");

    const response = await getMe({ pw_access: `${header}.${forgedPayload}.${signature}` });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a well-formed token signed with a different secret", async () => {
    const { cookies } = await register();
    const userId = JSON.parse(
      Buffer.from((cookies["pw_access"] ?? "").split(".")[1] ?? "", "base64url").toString(),
    ) as { sub: string };
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId.sub)
      .setIssuer("pulsewatch")
      .setAudience("pulsewatch-api")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("an-attacker-chosen-secret-0123456789abcdef"));

    expect((await getMe({ pw_access: forged })).statusCode).toBe(401);
  });

  it('rejects an unsigned token that claims the "none" algorithm', async () => {
    const { cookies } = await register();
    const payload = (cookies["pw_access"] ?? "").split(".")[1];
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

    expect((await getMe({ pw_access: `${header}.${payload}.` })).statusCode).toBe(401);
  });

  it("rejects a correctly signed token meant for a different audience", async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID())
      .setIssuer("pulsewatch")
      .setAudience("some-other-service")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(TEST_ACCESS_SECRET));

    expect((await getMe({ pw_access: forged })).statusCode).toBe(401);
  });

  it("rejects a valid token once the account has been deleted", async () => {
    const { email, cookies } = await register();
    await db.user.delete({ where: { email } });

    expect((await getMe(cookies)).statusCode).toBe(401);
  });
});

describe("POST /auth/refresh", () => {
  it("issues a new access token after the old one has expired", async () => {
    const { cookies } = await register();
    advanceClock(20 * MINUTE);
    expect((await getMe(cookies)).statusCode).toBe(401);

    const refreshed = await post("/api/v1/auth/refresh", undefined, cookies);

    expect(refreshed.statusCode).toBe(200);
    expect((await getMe(sessionCookies(refreshed))).statusCode).toBe(200);
  });

  it("rotates the refresh token: the new one differs and the old one is revoked", async () => {
    const { email, cookies } = await register();

    const refreshed = await post("/api/v1/auth/refresh", undefined, cookies);
    const rows = await db.refreshToken.findMany({
      where: { user: { email } },
      orderBy: { createdAt: "asc" },
    });

    expect(sessionCookies(refreshed)["pw_refresh"]).not.toBe(cookies["pw_refresh"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[1]?.revokedAt).toBeNull();
    expect(rows[1]?.familyId).toBe(rows[0]?.familyId);
  });

  it("treats re-use of a rotated token as theft and revokes the whole session", async () => {
    const { email, cookies: stolen } = await register();
    // The legitimate user refreshes; the copy held by the attacker is now stale.
    const legitimate = sessionCookies(await post("/api/v1/auth/refresh", undefined, stolen));

    const replay = await post("/api/v1/auth/refresh", undefined, stolen);

    expect(replay.statusCode).toBe(401);
    // The newer, legitimate token is revoked too: the server cannot tell
    // which holder is genuine, so both must log in again.
    expect((await post("/api/v1/auth/refresh", undefined, legitimate)).statusCode).toBe(401);
    expect(await db.refreshToken.count({ where: { user: { email }, revokedAt: null } })).toBe(0);
  });

  it("lets only one of two simultaneous refreshes with the same token succeed", async () => {
    const { cookies } = await register();

    const responses = await Promise.all([
      post("/api/v1/auth/refresh", undefined, cookies),
      post("/api/v1/auth/refresh", undefined, cookies),
    ]);

    expect(responses.filter((response) => response.statusCode === 200).length).toBeLessThanOrEqual(
      1,
    );
    expect(responses.some((response) => response.statusCode === 401)).toBe(true);
  });

  it("rejects an expired refresh token", async () => {
    const { cookies } = await register();
    advanceClock(7 * DAY + MINUTE);

    expect((await post("/api/v1/auth/refresh", undefined, cookies)).statusCode).toBe(401);
  });

  it.each([
    ["no cookie", {}],
    ["an unknown token", { pw_refresh: "not-a-token-the-server-ever-issued" }],
  ])("rejects %s and clears the cookies", async (_label, cookies) => {
    const response = await post("/api/v1/auth/refresh", undefined, cookies);

    expect(response.statusCode).toBe(401);
    expect(cookie(response, "pw_refresh")).toMatchObject({ value: "", path: "/api/v1/auth" });
    expect(cookie(response, "pw_access")).toMatchObject({ value: "", path: "/" });
  });

  it("keeps separate logins independent", async () => {
    const { email, cookies: laptop } = await register();
    const phone = sessionCookies(await post("/api/v1/auth/login", { email, password: PASSWORD }));

    await post("/api/v1/auth/logout", undefined, laptop);

    expect((await post("/api/v1/auth/refresh", undefined, laptop)).statusCode).toBe(401);
    expect((await post("/api/v1/auth/refresh", undefined, phone)).statusCode).toBe(200);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session and clears the cookies", async () => {
    const { cookies } = await register();

    const response = await post("/api/v1/auth/logout", undefined, cookies);

    expect(response.statusCode).toBe(204);
    expect(cookie(response, "pw_access")?.value).toBe("");
    expect(cookie(response, "pw_refresh")?.value).toBe("");
    expect((await post("/api/v1/auth/refresh", undefined, cookies)).statusCode).toBe(401);
  });

  it("succeeds even with no session, so it is safe to call twice", async () => {
    expect((await post("/api/v1/auth/logout")).statusCode).toBe(204);
  });
});

describe("cross-site request protection", () => {
  const credentials = { email: "a@example.com", password: PASSWORD };

  it("refuses a state-changing request from another origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://evil.example" },
      payload: credentials,
    });

    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe("FORBIDDEN");
  });

  it("allows the same request from the web app's own origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: APP_ORIGIN },
      payload: credentials,
    });

    // 401 (bad credentials) proves the request got past the origin check.
    expect(response.statusCode).toBe(401);
  });

  it("does not apply the check to read-only requests", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://evil.example" },
    });

    expect(response.statusCode).toBe(200);
  });
});
