import { z } from "zod";

/** The one error shape every endpoint returns (docs/api.md). */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Wraps a payload schema in the standard `{ data: ... }` success envelope. */
export function dataEnvelope<T extends z.ZodType>(payload: T): z.ZodObject<{ data: T }> {
  return z.object({ data: payload });
}
