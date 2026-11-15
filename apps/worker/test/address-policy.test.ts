import { describe, expect, it } from "vitest";
import { publicInternetOnly } from "../src/probe/address-policy.js";

describe("publicInternetOnly", () => {
  it.each([
    // IPv4
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback, far end of the /8"],
    ["10.0.0.1", "private 10/8"],
    ["172.16.0.1", "private 172.16/12, first address"],
    ["172.31.255.255", "private 172.16/12, last address"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "cloud metadata service"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast (SSDP)"],
    ["255.255.255.255", "broadcast"],
    ["198.18.0.1", "benchmarking"],
    ["192.0.2.1", "documentation"],
    // IPv6
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique local"],
    ["fd12:3456:789a::1", "unique local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    // IPv6 spellings of IPv4 addresses: the usual way round an IPv4-only filter
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata service"],
    ["::ffff:7f00:1", "IPv4-mapped loopback in hex"],
    ["64:ff9b::7f00:1", "NAT64-embedded loopback"],
    ["2002:7f00:1::", "6to4-embedded loopback"],
  ])("blocks %s (%s)", (address) => {
    expect(publicInternetOnly(address)).toEqual(expect.any(String));
  });

  it.each([
    ["8.8.8.8", "public DNS"],
    ["1.1.1.1", "public DNS"],
    ["93.184.216.34", "ordinary public host"],
    // Addresses immediately outside each blocked range: the off-by-one cases.
    ["9.255.255.255", "just below 10/8"],
    ["11.0.0.0", "just above 10/8"],
    ["172.15.255.255", "just below 172.16/12"],
    ["172.32.0.0", "just above 172.16/12"],
    ["192.167.255.255", "just below 192.168/16"],
    ["192.169.0.0", "just above 192.168/16"],
    ["169.253.255.255", "just below link-local"],
    ["169.255.0.0", "just above link-local"],
    ["100.63.255.255", "just below carrier-grade NAT"],
    ["100.128.0.0", "just above carrier-grade NAT"],
    ["126.255.255.255", "just below loopback"],
    ["128.0.0.0", "just above loopback"],
    ["223.255.255.255", "just below multicast"],
    ["2606:4700:4700::1111", "public IPv6"],
    ["2a00:1450:4009:81f::200e", "public IPv6"],
  ])("allows %s (%s)", (address) => {
    expect(publicInternetOnly(address)).toBeNull();
  });

  it.each(["", "localhost", "example.com", "999.1.1.1", "127.0.0.1:80", "1.2.3"])(
    "refuses %j, which is not an IP address",
    (value) => {
      expect(publicInternetOnly(value)).toBe("not an IP address");
    },
  );
});
