import { z } from "zod";
import { AppError } from "../errors.js";

/**
 * Opaque pagination cursors (docs/api.md, "Pagination").
 *
 * A cursor is the sort key of the last item on the previous page, encoded as
 * base64url JSON. Clients treat it as an opaque string; the server can change
 * what is inside without breaking them. The next page is then
 * "WHERE sort_key < cursor ORDER BY sort_key DESC LIMIT n", which reads
 * straight from the index whatever page you are on, unlike OFFSET.
 */
export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return schema.parse(parsed);
  } catch {
    // A cursor is produced by this server, so a bad one is a client bug or
    // tampering. Either way it gets a clean validation error, not a 500.
    throw new AppError(422, "VALIDATION_ERROR", "The query is invalid.", [
      { path: "cursor", message: "Invalid cursor." },
    ]);
  }
}

/** Shared query parameters for paginated lists. */
export const pageQuery = {
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};
