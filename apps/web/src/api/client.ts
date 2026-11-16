export const API_BASE = "/api/v1";

export interface ErrorDetail {
  path: string;
  message: string;
}

/** An error response from the API, in its standard shape (docs/api.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The message for one form field, if the API rejected it. */
  fieldError(path: string): string | undefined {
    return this.details.find((detail) => detail.path === path)?.message;
  }
}

/** The session could not be renewed; the user must log in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired. Log in again.");
    this.name = "SessionExpiredError";
  }
}

// Endpoints where a 401 means "wrong credentials" or "no session", never
// "access token expired", so refreshing and retrying would be pointless.
const NO_REFRESH = new Set(["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"]);

let refreshing: Promise<boolean> | null = null;

async function postRefresh(): Promise<boolean> {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    credentials: "same-origin",
  });
  return response.ok;
}

/**
 * Exchanges the refresh cookie for a new access token.
 *
 * The server treats a refresh token that is used twice as stolen and ends
 * the session (ADR-004). So refreshes must never overlap:
 *   - within a tab, concurrent callers share one in-flight promise;
 *   - across tabs, the Web Locks API runs them one at a time. Cookies are
 *     shared between tabs, so a tab that waited sends the token the previous
 *     tab just received, not the one it already used.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      if (typeof navigator !== "undefined" && "locks" in navigator) {
        return await navigator.locks.request("pulsewatch-session-refresh", postRefresh);
      }
      return await postRefresh();
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function send<T>(path: string, options: RequestOptions, allowRefresh: boolean): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    ...(hasBody
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // An expired access token: renew it once, then repeat the request.
  if (response.status === 401 && allowRefresh && !NO_REFRESH.has(path)) {
    if (await refreshSession()) return send<T>(path, options, false);
    throw new SessionExpiredError();
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: ErrorDetail[]; requestId?: string };
  } | null;

  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details ?? [],
      error?.requestId,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => send<T>(path, signal ? { signal } : {}, true),
  post: <T>(path: string, body?: unknown) =>
    send<T>(path, { method: "POST", ...(body === undefined ? {} : { body }) }, true),
  put: <T>(path: string, body: unknown) => send<T>(path, { method: "PUT", body }, true),
  patch: <T>(path: string, body: unknown) => send<T>(path, { method: "PATCH", body }, true),
  delete: (path: string) => send<undefined>(path, { method: "DELETE" }, true),
};

/** A message fit to show a user, whatever was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError || error instanceof SessionExpiredError) return error.message;
  if (error instanceof TypeError) return "Could not reach the server. Check your connection.";
  return "Something went wrong.";
}
