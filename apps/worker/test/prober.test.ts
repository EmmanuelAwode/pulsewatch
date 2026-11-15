import { once } from "node:events";
import { createServer, type Server } from "node:https";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { generate } from "selfsigned";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publicInternetOnly, type AddressPolicy } from "../src/probe/address-policy.js";
import { createProber, type Prober, type ProbeResult } from "../src/probe/prober.js";
import type { Resolver } from "../src/probe/resolve.js";

/**
 * The prober is tested against a real HTTPS server on this machine, with a
 * certificate generated for the test run. Nothing here touches the internet.
 *
 * The server listens on 127.0.0.1, which the production policy forbids, so
 * tests of ordinary behaviour use a policy that also allows loopback. The
 * SSRF tests use the real production policy against the same server and
 * assert that it never receives a request.
 */

const HOSTNAME = "probe.test";
const SLOW_DELAY_MS = 300;

let server: Server;
let port: number;
let certificate: string;
const hits: { method: string; path: string; userAgent: string }[] = [];

const toLoopback: Resolver = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
const allowLoopback: AddressPolicy = (address) =>
  address === "127.0.0.1" ? null : publicInternetOnly(address);

beforeAll(async () => {
  const pems = await generate([{ name: "commonName", value: HOSTNAME }], {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: HOSTNAME }] }],
  });
  certificate = pems.cert;

  server = createServer({ key: pems.private, cert: pems.cert }, (request, response) => {
    const path = request.url ?? "";
    hits.push({
      method: request.method ?? "",
      path,
      userAgent: request.headers["user-agent"] ?? "",
    });

    switch (path) {
      case "/ok":
      case "/ok?probe=1":
        response.writeHead(200).end("ok");
        break;
      case "/no-content":
        response.writeHead(204).end();
        break;
      case "/error":
        response.writeHead(500).end("boom");
        break;
      case "/missing":
        response.writeHead(404).end();
        break;
      case "/redirect":
        response.writeHead(302, { location: "/redirect-target" }).end();
        break;
      case "/slow":
        setTimeout(() => response.writeHead(200).end("slow"), SLOW_DELAY_MS);
        break;
      case "/hang":
        // Accept the request and never answer.
        break;
      case "/endless": {
        // Send headers, then stream a body that never finishes.
        response.writeHead(200);
        const chunk = Buffer.alloc(64 * 1024, "x");
        const timer = setInterval(() => response.write(chunk), 5);
        response.on("close", () => {
          clearInterval(timer);
        });
        break;
      }
      default:
        response.writeHead(200).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  hits.length = 0;
});

/** A prober that trusts the test certificate and may reach the local server. */
function localProber(overrides: Parameters<typeof createProber>[0] = {}): Prober {
  return createProber({
    resolver: toLoopback,
    addressPolicy: allowLoopback,
    allowedPorts: [port],
    ca: certificate,
    ...overrides,
  });
}

function urlFor(path: string, hostname = HOSTNAME): string {
  return `https://${hostname}:${port}${path}`;
}

function check(prober: Prober, path: string, timeoutMs = 5_000): Promise<ProbeResult> {
  return prober({ url: urlFor(path), method: "GET", timeoutMs });
}

describe("successful checks", () => {
  it("reports a 200 as success with a status code and latency", async () => {
    const result = await check(localProber(), "/ok");

    expect(result).toEqual({
      success: true,
      statusCode: 200,
      responseTimeMs: expect.any(Number) as number,
    });
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("treats any 2xx as success", async () => {
    expect(await check(localProber(), "/no-content")).toMatchObject({
      success: true,
      statusCode: 204,
    });
  });

  it("sends the path, query string, method and an identifying User-Agent", async () => {
    await localProber()({ url: urlFor("/ok?probe=1"), method: "HEAD", timeoutMs: 5_000 });

    expect(hits).toEqual([
      { method: "HEAD", path: "/ok?probe=1", userAgent: "PulseWatch/0.1 (uptime monitor)" },
    ]);
  });

  it("measures how long the endpoint took to respond", async () => {
    const result = await check(localProber(), "/slow");

    expect(result.success).toBe(true);
    // Allow a little timer slack below the delay; a generous bound above.
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(SLOW_DELAY_MS - 20);
    expect(result.responseTimeMs).toBeLessThan(SLOW_DELAY_MS + 2_000);
  });
});

describe("failed checks", () => {
  it.each([
    ["/error", 500],
    ["/missing", 404],
  ])(
    "reports %s as an HTTP_STATUS failure that keeps the status and latency",
    async (path, status) => {
      const result = await check(localProber(), path);

      expect(result).toEqual({
        success: false,
        statusCode: status,
        responseTimeMs: expect.any(Number) as number,
        errorType: "HTTP_STATUS",
        errorMessage: `The endpoint responded with HTTP ${status}.`,
      });
    },
  );

  it("does not follow a redirect", async () => {
    const result = await check(localProber(), "/redirect");

    expect(result).toMatchObject({ success: false, statusCode: 302, errorType: "HTTP_STATUS" });
    // The server saw the original request and nothing else.
    expect(hits.map((hit) => hit.path)).toEqual(["/redirect"]);
  });

  it("gives up at the timeout when the endpoint never answers", async () => {
    const startedAt = Date.now();

    const result = await check(localProber(), "/hang", 300);

    expect(result).toEqual({
      success: false,
      statusCode: null,
      responseTimeMs: null,
      errorType: "TIMEOUT",
      errorMessage: "No response within 300 ms.",
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("applies the timeout to DNS resolution too", async () => {
    const neverResolves: Resolver = () => new Promise(() => undefined);

    const result = await check(localProber({ resolver: neverResolves }), "/ok", 200);

    expect(result).toMatchObject({ success: false, errorType: "TIMEOUT" });
    expect(hits).toHaveLength(0);
  });

  it("returns as soon as the headers arrive, without downloading an endless body", async () => {
    const startedAt = Date.now();

    const result = await check(localProber(), "/endless", 3_000);

    expect(result).toMatchObject({ success: true, statusCode: 200 });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("reports an untrusted certificate as a TLS failure", async () => {
    // Without `ca`, the test certificate is just a self-signed certificate.
    const result = await check(createProber(baseOptions()), "/ok");

    expect(result).toMatchObject({ success: false, errorType: "TLS", statusCode: null });
    expect(hits).toHaveLength(0);
  });

  it("reports a certificate for a different hostname as a TLS failure", async () => {
    const result = await localProber()({
      url: urlFor("/ok", "other.test"),
      method: "GET",
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ success: false, errorType: "TLS" });
    expect(hits).toHaveLength(0);
  });

  it("reports a refused connection as a CONNECTION failure", async () => {
    // Reserve a port, then close it so nothing is listening there.
    const placeholder = createTcpServer().listen(0, "127.0.0.1");
    await once(placeholder, "listening");
    const closedPort = (placeholder.address() as AddressInfo).port;
    placeholder.close();
    await once(placeholder, "close");

    const result = await localProber({ allowedPorts: [closedPort] })({
      url: `https://${HOSTNAME}:${closedPort}/ok`,
      method: "GET",
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ success: false, errorType: "CONNECTION" });
  });

  it("reports an unresolvable hostname as a DNS failure", async () => {
    const failing: Resolver = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));

    const result = await check(localProber({ resolver: failing }), "/ok");

    expect(result).toMatchObject({ success: false, errorType: "DNS" });
  });
});

function baseOptions() {
  return { resolver: toLoopback, addressPolicy: allowLoopback, allowedPorts: [port] };
}

describe("SSRF protection (production address policy)", () => {
  /** Real policy, but allowed to use the test server's port so a request COULD arrive. */
  function productionProber(resolver: Resolver): Prober {
    return createProber({ resolver, allowedPorts: [port], ca: certificate });
  }

  it("refuses a hostname that resolves to loopback, and sends nothing", async () => {
    const result = await check(productionProber(toLoopback), "/ok");

    expect(result).toEqual({
      success: false,
      statusCode: null,
      responseTimeMs: null,
      errorType: "BLOCKED_ADDRESS",
      errorMessage: "The hostname resolves to an address that is not allowed.",
    });
    expect(hits).toHaveLength(0);
  });

  it.each(["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "2130706433", "0x7f.1"])(
    "refuses the address literal %s, and sends nothing",
    async (host) => {
      const resolver = vi.fn<Resolver>(toLoopback);

      const result = await productionProber(resolver)({
        url: `https://${host}:${port}/ok`,
        method: "GET",
        timeoutMs: 5_000,
      });

      expect(result).toMatchObject({ success: false, errorType: "BLOCKED_ADDRESS" });
      expect(hits).toHaveLength(0);
    },
  );

  it("does not reveal the blocked address in the stored message", async () => {
    const toMetadata: Resolver = () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]);

    const result = await check(productionProber(toMetadata), "/ok");

    expect(result).toMatchObject({ errorType: "BLOCKED_ADDRESS" });
    expect(JSON.stringify(result)).not.toContain("169.254");
  });

  it("resolves once and connects to the address it checked (DNS rebinding)", async () => {
    // A hostile DNS server: the first answer is the address that passes the
    // check, every later answer is an internal address. If the prober looked
    // the name up a second time when connecting, it would be sent to
    // 10.255.255.1 and this request would never reach the test server.
    let lookups = 0;
    const rebinding: Resolver = () => {
      lookups += 1;
      return Promise.resolve([
        { address: lookups === 1 ? "127.0.0.1" : "10.255.255.1", family: 4 as const },
      ]);
    };

    const result = await check(localProber({ resolver: rebinding }), "/ok");

    expect(result).toMatchObject({ success: true, statusCode: 200 });
    expect(lookups).toBe(1);
    expect(hits).toHaveLength(1);
  });

  it("refuses a port that is not allowed, before resolving anything", async () => {
    const resolver = vi.fn<Resolver>(toLoopback);
    const defaultPorts = createProber({ resolver, addressPolicy: allowLoopback, ca: certificate });

    const result = await check(defaultPorts, "/ok");

    expect(result).toMatchObject({ success: false, errorType: "BLOCKED_ADDRESS" });
    expect(resolver).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);
  });

  it.each([
    ["http://probe.test/ok", "plain HTTP"],
    ["https://user:secret@probe.test/ok", "embedded credentials"],
    ["ftp://probe.test/ok", "another scheme"],
  ])("refuses %s (%s) even if it reached the worker", async (url) => {
    const resolver = vi.fn<Resolver>(toLoopback);

    const result = await localProber({ resolver })({ url, method: "GET", timeoutMs: 5_000 });

    expect(result.success).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);
  });

  it("reports a malformed URL as a failure instead of throwing", async () => {
    const result = await localProber()({ url: "not a url", method: "GET", timeoutMs: 5_000 });

    expect(result).toMatchObject({ success: false, errorType: "UNKNOWN" });
  });
});
