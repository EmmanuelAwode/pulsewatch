import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { AppError, type ErrorCode, type ErrorDetail } from "../errors.js";
import type { ErrorResponse } from "./schemas.js";

/**
 * Framework-level client errors (raised by Fastify before a route handler
 * runs) that are safe to report, mapped to our public codes.
 */
const FRAMEWORK_CLIENT_ERRORS: Readonly<Record<number, { code: ErrorCode; message: string }>> = {
  400: { code: "BAD_REQUEST", message: "The request could not be understood." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported Content-Type." },
};

function send(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: readonly ErrorDetail[],
): FastifyReply {
  const body: ErrorResponse = {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details: [...details] } : {}),
      requestId: request.id,
    },
  };
  return reply.status(statusCode).send(body);
}

/** "/monitors/0/url" (JSON pointer) -> "monitors.0.url" */
function pointerToPath(instancePath: string): string {
  return instancePath.split("/").filter(Boolean).join(".");
}

/**
 * The single place where errors become HTTP responses.
 *
 * Centralising this gives three guarantees that per-route try/catch cannot:
 *   1. every error has the same JSON shape, so clients handle errors one way;
 *   2. nothing internal (stack trace, SQL, file path) reaches a client,
 *      because unknown errors are replaced by a generic message here;
 *   3. every unexpected error is logged with its request ID, and the same ID
 *      is in the response, so a user's report can be matched to a log line.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    send(request, reply, 404, "NOT_FOUND", "Route not found."),
  );

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    // 1. Errors we raised deliberately: the message is safe by construction.
    if (error instanceof AppError) {
      return send(request, reply, error.statusCode, error.code, error.message, error.details);
    }

    // 2. The request did not match the route's Zod schema.
    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((issue) => ({
        path: pointerToPath(issue.instancePath),
        message: issue.message ?? "Invalid value.",
      }));
      const where = error.validationContext ?? "request";
      return send(request, reply, 422, "VALIDATION_ERROR", `The ${where} is invalid.`, details);
    }

    // 3. Our own response did not match its declared schema. That is a server
    //    bug, so it is logged in full and reported as a generic 500.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, "response did not match its schema");
      return send(request, reply, 500, "INTERNAL_ERROR", "An unexpected error occurred.");
    }

    // 4. Client errors detected by Fastify itself (malformed JSON, body too
    //    large, ...). Fastify's own message can describe parser internals, so
    //    a fixed message is sent instead.
    const frameworkError =
      typeof error.statusCode === "number" ? FRAMEWORK_CLIENT_ERRORS[error.statusCode] : undefined;
    if (frameworkError) {
      return send(
        request,
        reply,
        error.statusCode ?? 400,
        frameworkError.code,
        frameworkError.message,
      );
    }

    // 5. Everything else is a bug or an outage. Log everything, reveal nothing.
    request.log.error({ err: error }, "unhandled error");
    return send(request, reply, 500, "INTERNAL_ERROR", "An unexpected error occurred.");
  });
}
