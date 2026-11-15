import { BlockList, isIP } from "node:net";

/**
 * Decides whether the worker may open a connection to an IP address.
 * Returns a short reason when the address is blocked, or null when it is a
 * normal public address.
 */
export type AddressPolicy = (address: string) => string | null;

/**
 * Address ranges that must never be reachable through a monitor (ADR-009).
 *
 * The list is "everything that is not ordinary public unicast space", taken
 * from the IANA special-purpose registries, rather than only the well-known
 * private ranges: an allow-by-default list with a few entries missing is how
 * SSRF filters get bypassed.
 */
const BLOCKED_RANGES: readonly (readonly [string, number, "ipv4" | "ipv6", string])[] = [
  // --- IPv4 ---
  ["0.0.0.0", 8, "ipv4", "unspecified ('this network')"],
  ["10.0.0.0", 8, "ipv4", "private network"],
  ["100.64.0.0", 10, "ipv4", "carrier-grade NAT"],
  ["127.0.0.0", 8, "ipv4", "loopback"],
  // Includes 169.254.169.254, the cloud metadata service that hands out
  // instance credentials: the classic SSRF target.
  ["169.254.0.0", 16, "ipv4", "link-local (includes cloud metadata)"],
  ["172.16.0.0", 12, "ipv4", "private network"],
  ["192.0.0.0", 24, "ipv4", "IETF protocol assignments"],
  ["192.0.2.0", 24, "ipv4", "documentation range"],
  ["192.88.99.0", 24, "ipv4", "deprecated 6to4 relay"],
  ["192.168.0.0", 16, "ipv4", "private network"],
  ["198.18.0.0", 15, "ipv4", "benchmarking range"],
  ["198.51.100.0", 24, "ipv4", "documentation range"],
  ["203.0.113.0", 24, "ipv4", "documentation range"],
  ["224.0.0.0", 4, "ipv4", "multicast"],
  ["240.0.0.0", 4, "ipv4", "reserved (includes broadcast)"],

  // --- IPv6 ---
  ["::", 128, "ipv6", "unspecified"],
  ["::1", 128, "ipv6", "loopback"],
  // Addresses that embed an IPv4 address. Each is a way to spell a blocked
  // IPv4 address so that an IPv4-only filter does not recognise it, e.g.
  // ::ffff:127.0.0.1. No legitimate public website needs them.
  ["::ffff:0:0", 96, "ipv6", "IPv4-mapped IPv6"],
  ["64:ff9b::", 96, "ipv6", "NAT64 (embeds an IPv4 address)"],
  ["64:ff9b:1::", 48, "ipv6", "local-use NAT64"],
  ["2002::", 16, "ipv6", "6to4 (embeds an IPv4 address)"],
  ["2001::", 23, "ipv6", "IETF protocol assignments (includes Teredo)"],
  ["100::", 64, "ipv6", "discard-only"],
  ["2001:db8::", 32, "ipv6", "documentation range"],
  ["fc00::", 7, "ipv6", "unique local (private network)"],
  ["fe80::", 10, "ipv6", "link-local"],
  ["ff00::", 8, "ipv6", "multicast"],
];

const rules = BLOCKED_RANGES.map(([prefix, bits, family, reason]) => {
  const list = new BlockList();
  list.addSubnet(prefix, bits, family);
  return { list, family, reason };
});

/**
 * The production policy.
 *
 * It takes an IP address, never a hostname or URL. That is deliberate: by the
 * time this runs, DNS has been resolved and every alternative spelling
 * (decimal "2130706433", hex "0x7f.1", a hostname pointing at 10.0.0.5) has
 * already been reduced by the operating system to the one address a socket
 * would actually connect to.
 */
export const publicInternetOnly: AddressPolicy = (address) => {
  const version = isIP(address);
  // Not an IP address at all: refuse rather than guess.
  if (version === 0) return "not an IP address";

  const family = version === 4 ? "ipv4" : "ipv6";
  for (const rule of rules) {
    if (rule.family === family && rule.list.check(address, family)) return rule.reason;
  }
  return null;
};
