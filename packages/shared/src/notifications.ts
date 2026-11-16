import { z } from "zod";

/**
 * Notification preferences a user may change.
 *
 * There is deliberately no "send alerts to this other address" field. Email
 * addresses are not verified in this version, so letting a user name any
 * recipient would turn a flapping monitor into a way to send unsolicited mail
 * to a stranger. Alerts go to the account's own email only (ADR-023).
 */
export const notificationSettingsSchema = z.object({
  emailEnabled: z.boolean(),
  notifyOnDown: z.boolean(),
  notifyOnRecovery: z.boolean(),
});

export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;

/** Used when a user has never saved preferences. Email is opt-in. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettingsInput = {
  emailEnabled: false,
  notifyOnDown: true,
  notifyOnRecovery: true,
};
