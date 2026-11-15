import { z } from "zod";
import {
  CHECK_INTERVAL_SECONDS,
  CHECK_TIMEOUT_MS,
  FAILURE_THRESHOLD,
  MONITOR_NAME_MAX_LENGTH,
  MONITOR_URL_MAX_LENGTH,
  RECOVERY_THRESHOLD,
} from "./monitoring.js";

/** Most monitors one account may have. Bounds how much work a single user can create. */
export const MAX_MONITORS_PER_USER = 50;

export const HTTP_METHODS = ["GET", "HEAD"] as const;

/**
 * Why a URL was refused, or null if it is acceptable.
 *
 * This is the FIRST layer of SSRF defence and deliberately the weakest: it
 * only looks at the text of the URL. It cannot know what a hostname will
 * resolve to, so it must never be the only check. The real protection is in
 * the worker, which validates the IP address actually connected to (ADR-009).
 * What this layer does is reject the obviously wrong early, with a clear
 * message, before anything is stored.
 */
function urlProblem(value: string): string | null {
  if (!URL.canParse(value)) return "Enter a valid URL.";
  const url = new URL(value);

  if (url.protocol !== "https:") return "Only https:// URLs can be monitored.";
  // "https://user:pass@host" would put credentials in our database and logs.
  if (url.username !== "" || url.password !== "") return "The URL must not contain credentials.";
  // An empty port means the default (443). Allowing any port would let a
  // monitor be used to probe which ports are open on a host.
  if (url.port !== "") return "Only the default HTTPS port (443) is allowed.";
  return null;
}

export const monitorUrlSchema = z
  .string()
  .trim()
  .max(MONITOR_URL_MAX_LENGTH, `URL must be at most ${MONITOR_URL_MAX_LENGTH} characters.`)
  .superRefine((value, context) => {
    const problem = urlProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(MONITOR_NAME_MAX_LENGTH, `Name must be at most ${MONITOR_NAME_MAX_LENGTH} characters.`);

function boundedInt(bounds: { min: number; max: number }, unit: string) {
  return z
    .number()
    .int()
    .min(bounds.min, `Must be at least ${bounds.min} ${unit}.`)
    .max(bounds.max, `Must be at most ${bounds.max} ${unit}.`);
}

const settings = {
  method: z.enum(HTTP_METHODS),
  intervalSeconds: boundedInt(CHECK_INTERVAL_SECONDS, "seconds"),
  timeoutMs: boundedInt(CHECK_TIMEOUT_MS, "milliseconds"),
  failureThreshold: boundedInt(FAILURE_THRESHOLD, "checks"),
  recoveryThreshold: boundedInt(RECOVERY_THRESHOLD, "checks"),
};

/** Name and URL are required; every setting falls back to its default. */
export const createMonitorSchema = z.object({
  name: nameSchema,
  url: monitorUrlSchema,
  method: settings.method.default("GET"),
  intervalSeconds: settings.intervalSeconds.default(CHECK_INTERVAL_SECONDS.default),
  timeoutMs: settings.timeoutMs.default(CHECK_TIMEOUT_MS.default),
  failureThreshold: settings.failureThreshold.default(FAILURE_THRESHOLD.default),
  recoveryThreshold: settings.recoveryThreshold.default(RECOVERY_THRESHOLD.default),
});

/**
 * A partial update: send only the fields being changed. An empty object is
 * rejected, since "change nothing" is almost certainly a client bug.
 */
export const updateMonitorSchema = z
  .object({
    name: nameSchema,
    url: monitorUrlSchema,
    ...settings,
    paused: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
