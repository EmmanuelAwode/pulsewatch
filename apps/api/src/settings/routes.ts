import type { PrismaClient } from "@pulsewatch/database";
import { DEFAULT_NOTIFICATION_SETTINGS, notificationSettingsSchema } from "@pulsewatch/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuthGuard } from "../auth/guard.js";
import { unauthenticated } from "../errors.js";
import { dataEnvelope, errorResponseSchema } from "../http/schemas.js";

interface SettingsRouteOptions {
  db: PrismaClient;
  requireAuth: AuthGuard;
}

const settingsResponse = dataEnvelope(
  notificationSettingsSchema.extend({
    /** Where alerts are sent: always the account email (see shared/notifications.ts). */
    email: z.string(),
  }),
);

/**
 * Notification preferences. Small enough that the queries live in the route
 * module; a service layer would add a file and no clarity.
 */
export const settingsRoutes: FastifyPluginAsyncZod<SettingsRouteOptions> = async (app, options) => {
  const { db, requireAuth } = options;
  app.addHook("onRequest", requireAuth);

  async function read(userId: string) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, notificationSettings: true },
    });
    if (!user) throw unauthenticated();
    const settings = user.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS;
    return {
      emailEnabled: settings.emailEnabled,
      notifyOnDown: settings.notifyOnDown,
      notifyOnRecovery: settings.notifyOnRecovery,
      email: user.email,
    };
  }

  app.get(
    "/notifications",
    {
      schema: {
        tags: ["settings"],
        summary: "Your notification preferences",
        response: { 200: settingsResponse, 401: errorResponseSchema },
      },
    },
    async (request) => ({ data: await read(request.userId) }),
  );

  app.put(
    "/notifications",
    {
      schema: {
        tags: ["settings"],
        summary: "Replace your notification preferences",
        body: notificationSettingsSchema,
        response: { 200: settingsResponse, 401: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    async (request) => {
      // PUT on a singleton resource: create it the first time, replace it after.
      await db.notificationSettings.upsert({
        where: { userId: request.userId },
        create: { userId: request.userId, ...request.body },
        update: request.body,
      });
      return { data: await read(request.userId) };
    },
  );

  await Promise.resolve();
};
