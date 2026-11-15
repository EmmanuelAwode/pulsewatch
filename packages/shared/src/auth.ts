import { z } from "zod";

/**
 * Validation rules for credentials, shared by the API (enforcement) and the
 * web app (instant form feedback) so the two can never disagree.
 */

/** RFC 5321 caps an address at 254 characters. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Length matters far more than character-class rules (NIST SP 800-63B), so
 * the only requirements are a minimum length and an upper bound. The upper
 * bound exists because hashing cost grows with input size: without it, a
 * megabyte-long "password" is a cheap way to tie up the server.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Trimmed and lower-cased, so "User@Example.com " and "user@example.com" are one account. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address.").max(EMAIL_MAX_LENGTH));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

export const registerSchema = z.object({ email: emailSchema, password: passwordSchema });

/**
 * Login deliberately does NOT apply the password length rules: telling an
 * attacker "too short" before checking credentials would reveal the policy,
 * and an old account must stay able to log in if the policy is tightened.
 * Only the upper bound is kept, for the cost reason above.
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required.").max(PASSWORD_MAX_LENGTH),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
