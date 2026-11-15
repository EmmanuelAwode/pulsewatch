import type { FastifyInstance } from "fastify";
import { AppError } from "../errors.js";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Second layer of CSRF defence (the first is the SameSite cookie attribute).
 *
 * Authentication uses cookies, which browsers attach automatically. A
 * malicious page could therefore try to submit a request to this API from the
 * victim's browser. Browsers add an `Origin` header to such requests, naming
 * the page that sent them, and page JavaScript cannot forge it. So any
 * state-changing request whose Origin is not our own web app is refused.
 *
 * Requests with no Origin header are allowed: they come from non-browser
 * clients (curl, server-to-server, tests), which hold no ambient cookies for
 * an attacker to abuse.
 */
export function registerOriginCheck(app: FastifyInstance, allowedOrigin: string): void {
  app.addHook("onRequest", async (request) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      throw new AppError(403, "FORBIDDEN", "Cross-site requests are not allowed.");
    }
    await Promise.resolve();
  });
}
