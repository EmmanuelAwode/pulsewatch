import { loginSchema, registerSchema } from "@pulsewatch/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuthConfig } from "../config.js";
import { unauthenticated } from "../errors.js";
import { dataEnvelope, errorResponseSchema } from "../http/schemas.js";
import { clearSessionCookies, REFRESH_COOKIE, setSessionCookies } from "./cookies.js";
import type { AuthGuard } from "./guard.js";
import type { AuthService, PublicUser } from "./service.js";

interface AuthRouteOptions {
  auth: AuthService;
  requireAuth: AuthGuard;
  config: AuthConfig;
}

/**
 * The only user fields that may leave the API. Because response schemas are
 * an allow-list, a password hash cannot be returned even by mistake.
 */
const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  createdAt: z.iso.datetime(),
});

const sessionResponse = dataEnvelope(z.object({ user: userSchema }));

/** Converts the service's user into its JSON form (dates become ISO 8601 UTC strings). */
function toUserDto(user: PublicUser): z.infer<typeof userSchema> {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

const TAGS = ["auth"];

/**
 * HTTP layer for authentication. Each handler does three things only:
 * call the service, set or clear cookies, shape the response. Tokens travel
 * exclusively in cookies and are never placed in a response body, where
 * page JavaScript could read them.
 */
export const authRoutes: FastifyPluginAsyncZod<AuthRouteOptions> = async (app, options) => {
  const { auth, requireAuth, config } = options;

  app.post(
    "/register",
    {
      // Much tighter than the global limit: these are the endpoints a password
      // guesser or a sign-up spammer would hammer.
      config: { rateLimitTier: "auth" },
      schema: {
        tags: TAGS,
        summary: "Create an account and start a session",
        body: registerSchema,
        response: { 201: sessionResponse, 409: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const session = await auth.register(request.body);
      setSessionCookies(reply, session, config);
      return reply.status(201).send({ data: { user: toUserDto(session.user) } });
    },
  );

  app.post(
    "/login",
    {
      // Much tighter than the global limit: these are the endpoints a password
      // guesser or a sign-up spammer would hammer.
      config: { rateLimitTier: "auth" },
      schema: {
        tags: TAGS,
        summary: "Start a session",
        body: loginSchema,
        response: { 200: sessionResponse, 401: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const session = await auth.login(request.body);
      setSessionCookies(reply, session, config);
      return { data: { user: toUserDto(session.user) } };
    },
  );

  app.post(
    "/refresh",
    {
      schema: {
        tags: TAGS,
        summary: "Rotate the refresh token and issue a new access token",
        response: { 200: sessionResponse, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const session = await auth.refresh(request.cookies[REFRESH_COOKIE]);
        setSessionCookies(reply, session, config);
        return { data: { user: toUserDto(session.user) } };
      } catch (error) {
        // A dead session's cookies are useless; remove them so the browser
        // stops sending them.
        clearSessionCookies(reply, config);
        throw error;
      }
    },
  );

  app.post(
    "/logout",
    {
      schema: {
        tags: TAGS,
        summary: "End the session",
        description:
          "Revokes the refresh token family. Works even when the access token has expired, and always succeeds.",
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await auth.logout(request.cookies[REFRESH_COOKIE]);
      clearSessionCookies(reply, config);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/me",
    {
      onRequest: requireAuth,
      schema: {
        tags: TAGS,
        summary: "The authenticated user",
        response: { 200: sessionResponse, 401: errorResponseSchema },
      },
    },
    async (request) => {
      // A valid token for an account that has since been deleted must not
      // authenticate, so this one endpoint does consult the database.
      const user = await auth.getUser(request.userId);
      if (!user) throw unauthenticated();
      return { data: { user: toUserDto(user) } };
    },
  );

  await Promise.resolve();
};
