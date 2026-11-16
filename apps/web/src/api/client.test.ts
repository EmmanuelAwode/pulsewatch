import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, refreshSession, SessionExpiredError } from "./client";

/**
 * The client's session handling, with `fetch` replaced by a scripted fake.
 * These rules matter because the server ends the whole session if a refresh
 * token is ever used twice (ADR-004).
 */

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let calls: { url: string; method: string }[];

function stubFetch(handler: Handler) {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return Promise.resolve(handler(url, init));
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("returns the parsed body of a successful response", async () => {
    stubFetch(() => json(200, { data: { ok: true } }));

    await expect(api.get("/dashboard")).resolves.toEqual({ data: { ok: true } });
  });

  it("turns an error response into an ApiError carrying field details", async () => {
    stubFetch(() =>
      json(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "The body is invalid.",
          details: [{ path: "url", message: "Only https:// URLs can be monitored." }],
          requestId: "req-1",
        },
      }),
    );

    const error = await api
      .post("/monitors", { url: "http://x" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "VALIDATION_ERROR", requestId: "req-1" });
    expect((error as ApiError).fieldError("url")).toBe("Only https:// URLs can be monitored.");
  });

  it("renews an expired access token once and repeats the request", async () => {
    let expired = true;
    stubFetch((url) => {
      if (url.endsWith("/auth/refresh")) {
        expired = false;
        return new Response(null, { status: 200 });
      }
      return expired ? json(401, { error: { code: "UNAUTHENTICATED" } }) : json(200, { data: 1 });
    });

    await expect(api.get("/dashboard")).resolves.toEqual({ data: 1 });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/dashboard",
      "/api/v1/auth/refresh",
      "/api/v1/dashboard",
    ]);
  });

  it("reports an expired session when the refresh is refused", async () => {
    stubFetch((url) =>
      url.endsWith("/auth/refresh")
        ? json(401, { error: { code: "UNAUTHENTICATED" } })
        : json(401, { error: { code: "UNAUTHENTICATED" } }),
    );

    await expect(api.get("/dashboard")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("does not try to refresh after a failed login", async () => {
    stubFetch(() =>
      json(401, {
        error: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." },
      }),
    );

    await expect(api.post("/auth/login", { email: "a@b.c", password: "x" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends one refresh for many requests that expire at the same time", async () => {
    let expired = true;
    let refreshes = 0;
    stubFetch(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expired = false;
        return new Response(null, { status: 200 });
      }
      return expired ? json(401, {}) : json(200, { data: url });
    });

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c"), refreshSession()]);

    // A second refresh with the same token would be treated as theft and end
    // the session, so concurrent callers must share one.
    expect(refreshes).toBe(1);
  });

  it("sends no body or content type on a request without one", async () => {
    let seen: RequestInit | undefined;
    stubFetch((_url, init) => {
      seen = init;
      return new Response(null, { status: 204 });
    });

    await api.post("/auth/logout");

    expect(seen?.body).toBeUndefined();
    expect(seen?.headers).toBeUndefined();
  });
});
