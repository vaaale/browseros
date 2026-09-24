// Proves the unit suite's network guard is actually installed and correctly
// scoped.
//   npm run test:unit -- tests/network-guard.test.ts
//
// The guard (tests/_no-external-network.cjs) is wired through NODE_OPTIONS in
// the `test:unit` npm script, which is exactly the kind of thing that gets
// dropped by an unrelated edit to package.json without anyone noticing. It is
// load-bearing: nothing in src/ short-circuits a model call when no provider
// is configured (src/lib/agent/llm.ts sends the request with the api key
// "MISSING"), so with the guard gone, any test that reaches runSubAgent
// silently starts talking to a real provider again — a developer's LAN LLM
// server or the live Anthropic API — and the suite goes back to passing or
// timing out based on how fast that external service answers.
//
// So: assert the guard, not just the behaviour that depends on it.

import { test, expect } from "@playwright/test";
import net from "node:net";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** RFC 5737 TEST-NET-1 — reserved for documentation and guaranteed never
 *  routed. Chosen deliberately: if the guard were missing, this attempt goes
 *  nowhere real rather than poking someone's actual server. */
const UNROUTABLE_HOST = "192.0.2.1";

function connectError(host: string, port: number): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect to ${host}:${port} neither succeeded nor failed within 5s — the guard is NOT installed (it fails fast); run via 'npm run test:unit'`));
    }, 5000);
    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(err);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`connect to ${host}:${port} SUCCEEDED — external egress is not blocked`));
    });
    socket.connect(port, host);
  });
}

test.describe("unit-suite network guard", () => {
  test("blocks an outbound connection to a non-loopback host", async () => {
    const err = await connectError(UNROUTABLE_HOST, 443);
    // The specific code can only come from the guard — a genuine network
    // failure would be ECONNREFUSED/EHOSTUNREACH/ETIMEDOUT.
    expect(err.code).toBe("EPERM_TEST_NETWORK_BLOCKED");
    expect(err.message).toContain(UNROUTABLE_HOST);
  });

  test("still allows loopback, so tests may spawn local servers", async () => {
    // Over-blocking would be its own bug: tests/bastion spawns real HTTP
    // servers on 127.0.0.1 and talks to the Docker unix socket.
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
          let out = "";
          res.on("data", (c) => (out += c));
          res.on("end", () => resolve(out));
        }).on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("allows 'localhost' by name as well as by address", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ hostname: "localhost", port, path: "/" }, (res) => {
          let out = "";
          res.on("data", (c) => (out += c));
          res.on("end", () => resolve(out));
        }).on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
