/**
 * Machine-readable error codes returned to clients. The frontend switches on
 * these, so they are part of the public API: add new ones, never rename.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ErrorDetail {
  /** Dotted path to the offending field, e.g. "intervalSeconds". Empty for whole-request problems. */
  path: string;
  message: string;
}

/**
 * An error the application raised on purpose and whose message is safe to
 * show to the client.
 *
 * Services throw these; they know nothing about HTTP beyond the status code.
 * Anything that is NOT an AppError is treated as a bug by the error handler
 * and is hidden from the client.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message = "Resource not found."): AppError =>
  new AppError(404, "NOT_FOUND", message);

export const conflict = (message: string): AppError => new AppError(409, "CONFLICT", message);

export const unauthenticated = (message = "Authentication is required."): AppError =>
  new AppError(401, "UNAUTHENTICATED", message);

export const serviceUnavailable = (message: string, details?: readonly ErrorDetail[]): AppError =>
  new AppError(503, "SERVICE_UNAVAILABLE", message, details);
