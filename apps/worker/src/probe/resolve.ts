import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AddressPolicy } from "./address-policy.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Turns a hostname into its IP addresses. Injected so tests need no real DNS. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** The operating system's resolver: the same answer any other program on this host would get. */
export const systemResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, order: "verbatim" });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

/** The hostname resolved, but to an address the policy forbids. */
export class BlockedAddressError extends Error {
  constructor(
    readonly address: string,
    readonly reason: string,
  ) {
    super(`address ${address} is blocked: ${reason}`);
    this.name = "BlockedAddressError";
  }
}

/** The hostname did not resolve to any address. */
export class ResolutionError extends Error {
  constructor(hostname: string, options?: ErrorOptions) {
    super(`could not resolve ${hostname}`, options);
    this.name = "ResolutionError";
  }
}

/**
 * Resolves a hostname ONCE and returns a single address that passed the
 * policy. The caller must connect to exactly that address.
 *
 * This is the defence against DNS rebinding. The naive approach is
 * "resolve, check, then let the HTTP client connect to the hostname". The
 * HTTP client resolves the name a second time, and an attacker who controls
 * the DNS server can answer the first query with a public address (passes the
 * check) and the second with 127.0.0.1 (gets connected to). Returning the
 * checked address, and connecting to it rather than to the name, leaves no
 * second lookup to tamper with.
 *
 * If ANY returned address is blocked, the whole resolution is refused. A
 * legitimate public site has no reason to publish an internal address next to
 * a public one, and accepting such a set would leave the choice of address to
 * connection-level fallback logic.
 */
export async function resolvePinned(
  hostname: string,
  resolver: Resolver,
  policy: AddressPolicy,
): Promise<ResolvedAddress> {
  // URL.hostname keeps the brackets around an IPv6 literal: "[::1]".
  const host = hostname.replace(/^\[|\]$/g, "");

  const literal = isIP(host);
  const candidates: ResolvedAddress[] =
    literal === 0
      ? await resolver(host).catch((error: unknown) => {
          throw new ResolutionError(host, { cause: error });
        })
      : [{ address: host, family: literal === 6 ? 6 : 4 }];

  const [first] = candidates;
  if (!first) throw new ResolutionError(host);

  for (const candidate of candidates) {
    const reason = policy(candidate.address);
    if (reason !== null) throw new BlockedAddressError(candidate.address, reason);
  }
  return first;
}
