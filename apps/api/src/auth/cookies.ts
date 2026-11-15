import type { FastifyReply } from "fastify";
import type { AuthConfig } from "../config.js";
import type { Session } from "./service.js";

export const ACCESS_COOKIE = "pw_access";
export const REFRESH_COOKIE = "pw_refresh";

/**
 * The refresh cookie is only ever sent to the auth endpoints. Every other
 * request carries just the short-lived access token, so the long-lived
 * credential is exposed as little as possible.
 */
const REFRESH_COOKIE_PATH = "/api/v1/auth";

/**
 * Cookie attributes, and what each one defends against:
 *
 *   httpOnly  JavaScript cannot read the cookie, so an XSS bug cannot steal
 *             the token (the main reason tokens are not in localStorage).
 *   secure    Sent over HTTPS only. Off in development, where the dev server
 *             is plain HTTP on localhost.
 *   sameSite  The browser withholds the cookie on cross-site requests, which
 *             is the primary CSRF defence. "strict" for the refresh token;
 *             "lax" for the access token so that following a link into the
 *             app from elsewhere still arrives logged in.
 */
export function setSessionCookies(reply: FastifyReply, session: Session, config: AuthConfig): void {
  reply.setCookie(ACCESS_COOKIE, session.accessToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: config.accessTtlSeconds,
  });
  reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: config.refreshTtlSeconds,
  });
}

export function clearSessionCookies(reply: FastifyReply, config: AuthConfig): void {
  // A cookie is only cleared if the path (and other attributes) match the
  // ones it was set with.
  reply.clearCookie(ACCESS_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
  });
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
  });
}
