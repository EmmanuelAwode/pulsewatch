import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { publicInternetOnly, type AddressPolicy } from "./address-policy.js";
import {
  BlockedAddressError,
  ResolutionError,
  resolvePinned,
  systemResolver,
  type ResolvedAddress,
  type Resolver,
} from "./resolve.js";

/** Mirrors the `check_error_type` enum in the database. */
export type ProbeErrorType =
  | "TIMEOUT"
  | "DNS"
  | "CONNECTION"
  | "TLS"
  | "BLOCKED_ADDRESS"
  | "HTTP_STATUS"
  | "RESPONSE_TOO_LARGE"
  | "UNKNOWN";

export interface ProbeTarget {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
}

/**
 * The outcome of one check. A failed check is a normal return value, never a
 * thrown error: "the endpoint is down" is a measurement, not a malfunction of
 * ours (ADR-003).
 */
export type ProbeResult =
  | { success: true; statusCode: number; responseTimeMs: number }
  | {
      success: false;
      statusCode: number | null;
      responseTimeMs: number | null;
      errorType: ProbeErrorType;
      errorMessage: string;
    };

export interface ProberOptions {
  /** DNS resolution. Defaults to the operating system's resolver. */
  resolver?: Resolver;
  /** Which addresses may be connected to. Defaults to public internet only. */
  addressPolicy?: AddressPolicy;
  /** Ports that may be connected to. Defaults to 443 only. */
  allowedPorts?: readonly number[];
  /** Extra trusted certificate authorities. Only tests set this. */
  ca?: string;
}

export type Prober = (target: ProbeTarget) => Promise<ProbeResult>;

const USER_AGENT = "PulseWatch/0.1 (uptime monitor)";

/** Time from a `process.hrtime.bigint()` reading until now, in whole milliseconds. */
function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function failure(
  errorType: ProbeErrorType,
  errorMessage: string,
  statusCode: number | null = null,
  responseTimeMs: number | null = null,
): ProbeResult {
  return { success: false, statusCode, responseTimeMs, errorType, errorMessage };
}

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EADDRNOTAVAIL",
]);

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "EPROTO",
]);

/**
 * Maps a low-level error to one of our categories and a FIXED message.
 *
 * The message is chosen here rather than copied from the error because it is
 * stored and later shown to the user. Raw socket errors can contain internal
 * IP addresses and resolver details, which is exactly the information an SSRF
 * attempt is trying to extract.
 */
function classify(error: unknown): ProbeResult {
  if (error instanceof BlockedAddressError) {
    return failure("BLOCKED_ADDRESS", "The hostname resolves to an address that is not allowed.");
  }
  if (error instanceof ResolutionError) {
    return failure("DNS", "The hostname could not be resolved.");
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return failure("DNS", "The hostname could not be resolved.");
    }
    if (CONNECTION_CODES.has(code)) {
      return failure("CONNECTION", "The connection could not be established.");
    }
    if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) {
      return failure("TLS", "The TLS handshake or certificate validation failed.");
    }
    if (code === "HPE_HEADER_OVERFLOW") {
      return failure("RESPONSE_TOO_LARGE", "The response headers exceeded the size limit.");
    }
  }
  return failure("UNKNOWN", "The check failed for an unrecognised reason.");
}

/**
 * Creates the function that performs one HTTPS check.
 *
 * Security properties (ADR-009), each of which has a test:
 *   - HTTPS only, and only to an allowed port.
 *   - The hostname is resolved once, every address is checked against the
 *     policy, and the socket is forced to connect to the checked address.
 *   - Redirects are never followed; a 3xx is recorded as the result.
 *   - A hard deadline covers DNS, connect, TLS and waiting for the response.
 *   - The response body is never downloaded, so its size cannot hurt us.
 */
export function createProber(options: ProberOptions = {}): Prober {
  const resolver = options.resolver ?? systemResolver;
  const policy = options.addressPolicy ?? publicInternetOnly;
  const allowedPorts = options.allowedPorts ?? [443];

  return async function probe(target) {
    // Monotonic clock: unlike Date.now(), it cannot jump when the system
    // clock is adjusted (NTP sync, daylight saving), so a duration measured
    // with it is always correct.
    const startedAt = process.hrtime.bigint();

    // The API validates URLs on the way in, but the worker does not trust
    // that: it re-checks what it is about to act on.
    if (!URL.canParse(target.url)) return failure("UNKNOWN", "The URL is not valid.");
    const url = new URL(target.url);
    const port = url.port === "" ? 443 : Number(url.port);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return failure("BLOCKED_ADDRESS", "Only https:// URLs without credentials can be checked.");
    }
    if (!allowedPorts.includes(port)) {
      return failure("BLOCKED_ADDRESS", "The port is not allowed.");
    }

    // One deadline for the whole check, enforced by aborting the request.
    const deadline = AbortSignal.timeout(target.timeoutMs);
    const timedOut = (): ProbeResult =>
      failure("TIMEOUT", `No response within ${target.timeoutMs} ms.`);

    let pinned: ResolvedAddress;
    try {
      pinned = await Promise.race([
        resolvePinned(url.hostname, resolver, policy),
        new Promise<never>((_, reject) => {
          deadline.addEventListener("abort", () => {
            reject(new DOMException("deadline exceeded", "TimeoutError"));
          });
        }),
      ]);
    } catch (error) {
      return deadline.aborted ? timedOut() : classify(error);
    }

    // Whatever name Node asks to resolve, it gets the address we validated.
    // This is what makes the connection go to the checked IP while TLS still
    // verifies the certificate against the original hostname.
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) {
        callback(null, [pinned]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };

    return new Promise<ProbeResult>((resolve) => {
      const outgoing = request(
        {
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port,
          path: `${url.pathname}${url.search}`,
          method: target.method,
          headers: { "user-agent": USER_AGENT, accept: "*/*" },
          lookup: pinnedLookup,
          // A fresh connection per check. A pooled keep-alive socket would be
          // reused without a new lookup, and would also hide connect and TLS
          // time from the measurement.
          agent: false,
          signal: deadline,
          ...(options.ca ? { ca: options.ca } : {}),
        },
        (response) => {
          const responseTimeMs = elapsedMs(startedAt);
          const statusCode = response.statusCode ?? 0;
          // The status line and headers are all we need. Dropping the
          // connection here means the body is never read into memory.
          response.destroy();

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ success: true, statusCode, responseTimeMs });
          } else {
            resolve(
              failure(
                "HTTP_STATUS",
                `The endpoint responded with HTTP ${statusCode}.`,
                statusCode,
                responseTimeMs,
              ),
            );
          }
        },
      );

      // Belt and braces: confirm the socket really connected where we
      // intended, in case a future change bypasses the pinned lookup.
      outgoing.on("socket", (socket) => {
        socket.once("connect", () => {
          const reason = socket.remoteAddress ? policy(socket.remoteAddress) : "unknown peer";
          if (reason !== null) {
            outgoing.destroy(new BlockedAddressError(socket.remoteAddress ?? "unknown", reason));
          }
        });
      });

      outgoing.on("error", (error) => {
        resolve(deadline.aborted ? timedOut() : classify(error));
      });

      outgoing.end();
    });
  };
}
