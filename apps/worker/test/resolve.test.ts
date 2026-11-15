import { describe, expect, it, vi } from "vitest";
import { publicInternetOnly } from "../src/probe/address-policy.js";
import {
  BlockedAddressError,
  ResolutionError,
  resolvePinned,
  type ResolvedAddress,
  type Resolver,
} from "../src/probe/resolve.js";

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: ResolvedAddress = { address: "2606:4700:4700::1111", family: 6 };
const LOOPBACK: ResolvedAddress = { address: "127.0.0.1", family: 4 };
const PRIVATE: ResolvedAddress = { address: "10.0.0.5", family: 4 };

function resolverReturning(...answers: ResolvedAddress[]) {
  return vi.fn<Resolver>(() => Promise.resolve(answers));
}

describe("resolvePinned", () => {
  it("returns the address of a hostname that resolves to a public IP", async () => {
    const resolver = resolverReturning(PUBLIC);

    await expect(resolvePinned("example.com", resolver, publicInternetOnly)).resolves.toEqual(
      PUBLIC,
    );
    expect(resolver).toHaveBeenCalledExactlyOnceWith("example.com");
  });

  it("blocks an innocent-looking hostname that resolves to a private IP", async () => {
    const resolver = resolverReturning(PRIVATE);

    await expect(
      resolvePinned("internal.example.com", resolver, publicInternetOnly),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks the whole answer when one of several addresses is private", async () => {
    // An attacker publishes a public and an internal address together, hoping
    // the check passes on the first and the connection falls back to the second.
    for (const answers of [
      [PUBLIC, LOOPBACK],
      [LOOPBACK, PUBLIC],
      [PUBLIC_V6, PRIVATE],
    ]) {
      await expect(
        resolvePinned("mixed.example.com", resolverReturning(...answers), publicInternetOnly),
      ).rejects.toBeInstanceOf(BlockedAddressError);
    }
  });

  it("returns the first address when every address is public", async () => {
    const resolver = resolverReturning(PUBLIC_V6, PUBLIC);

    await expect(resolvePinned("example.com", resolver, publicInternetOnly)).resolves.toEqual(
      PUBLIC_V6,
    );
  });

  it.each(["127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "[fe80::1]", "[::ffff:10.0.0.1]"])(
    "blocks the IP literal %s without consulting DNS",
    async (host) => {
      const resolver = resolverReturning(PUBLIC);

      await expect(resolvePinned(host, resolver, publicInternetOnly)).rejects.toBeInstanceOf(
        BlockedAddressError,
      );
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["https://2130706433/", "decimal integer"],
    ["https://0x7f000001/", "hexadecimal integer"],
    ["https://017700000001/", "octal integer"],
    ["https://0x7f.1/", "mixed hex, short form"],
    ["https://127.1/", "short form"],
    ["https://0/", "zero"],
    ["https://[0:0:0:0:0:ffff:7f00:1]/", "expanded IPv4-mapped IPv6"],
  ])("blocks %s, loopback written as a %s", async (url) => {
    // The URL parser normalises every one of these to a plain IP literal, so
    // the policy sees the real address whatever the spelling.
    const resolver = resolverReturning(PUBLIC);

    await expect(
      resolvePinned(new URL(url).hostname, resolver, publicInternetOnly),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("accepts a public IP literal", async () => {
    await expect(
      resolvePinned("93.184.216.34", resolverReturning(), publicInternetOnly),
    ).resolves.toEqual(PUBLIC);
  });

  it("reports a hostname with no addresses as a resolution failure", async () => {
    await expect(
      resolvePinned("nothing.example.com", resolverReturning(), publicInternetOnly),
    ).rejects.toBeInstanceOf(ResolutionError);
  });

  it("reports a resolver error as a resolution failure", async () => {
    const resolver = vi.fn<Resolver>(() => Promise.reject(new Error("ENOTFOUND")));

    await expect(
      resolvePinned("missing.example.com", resolver, publicInternetOnly),
    ).rejects.toBeInstanceOf(ResolutionError);
  });
});
