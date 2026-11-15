import type { FastifyRequest } from "fastify";
import { unauthenticated } from "../errors.js";
import { ACCESS_COOKIE } from "./cookies.js";
import type { TokenService } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth guard. Empty on routes that do not use it. */
    userId: string;
  }
}

export type AuthGuard = (request: FastifyRequest) => Promise<void>;

/**
 * Returns a `preHandler` that rejects unauthenticated requests and records
 * who the caller is.
 *
 * It verifies the access token's signature and expiry and nothing else: no
 * database query. That is the benefit of a short-lived signed token, and it
 * is what lets any API instance authenticate any request with no shared
 * session store.
 *
 * Handlers must take the user ID from `request.userId`, never from the URL or
 * body, and must include it in every query for a user-owned resource.
 */
export function createAuthGuard(tokens: TokenService): AuthGuard {
  return async (request) => {
    const token = request.cookies[ACCESS_COOKIE];
    const userId = token ? await tokens.verifyAccessToken(token) : null;
    if (!userId) throw unauthenticated();
    request.userId = userId;
  };
}
