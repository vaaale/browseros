// bastion/src/proxy.ts WebSocket-upgrade authentication and single-target
// dispatch.
//   npx playwright test -c playwright.unit.config.ts tests/bastion/proxy-ws-upgrade-auth.test.ts
//
// Regression cover for the incident where the Terminal app stopped working in
// the Dokploy deployment. `createBosProxy` builds ONE proxy instance per user,
// each pinned to that user's own container, and each was created with
// `ws: true` — which makes http-proxy-middleware lazily self-subscribe to the
// shared HTTP server's "upgrade" event on its first HTTP request. Node invokes
// EVERY "upgrade" listener for EVERY upgrade, so with N users active each
// WebSocket was proxied into all N containers at once (N "101 Switching
// Protocols" responses written onto one client socket, which breaks the
// connection — the visible Terminal symptom), and that self-subscribed
// listener runs OUTSIDE Express, so it performed NO authentication at all:
// an unauthenticated upgrade reached every provisioned user's container.
//
// Two invariants are locked in here:
//   1. Bastion attaches exactly ONE upgrade listener, and the per-user proxies
//      never self-subscribe (the `ws: true` library behaviour that caused the
//      fan-out is pinned directly, so a future edit re-enabling it fails here).
//   2. Every upgrade is authenticated before any dispatch — by session cookie
//      (parsed from the raw header; there is no cookie-parser on this path) or
//      by a headless per-service secret, with forged claim headers stripped.
//
// NOTE on coverage: the final hop — "the authenticated upgrade reaches exactly
// one CONTAINER" — is not asserted end-to-end here, because a dispatch
// requires getInstanceState(user) === "running", which lifecycle.ts only ever
// reaches by actually inspecting Docker (loadInstancesFromDisk deliberately
// re-loads every persisted instance as "unknown"). These tests therefore
// assert dispatch was REACHED, using the same 401-vs-503 distinction
// proxy-headless-auth.test.ts uses: 401 = refused at authentication, 503 =
// authenticated and routed, then declined because no container is running.

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { createBosProxy } from "../../bastion/src/proxy";
import type { Config } from "../../bastion/src/config";

// `http-proxy-middleware` lives in bastion/'s own node_modules, which this
// root-level test file cannot resolve by directory-walk (bastion/src/proxy.ts
// can, being inside it). Resolve it AS bastion would rather than adding a root
// dependency for one test — the point of that test is to pin the real
// library's behaviour, so the real installed copy is what must be loaded.
type MinimalProxyFactory = (options: { target: string; ws: boolean }) => (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void,
) => void;
const createProxyMiddleware = (
  createRequire(path.join(__dirname, "..", "..", "bastion", "src", "proxy.ts"))("http-proxy-middleware") as {
    createProxyMiddleware: MinimalProxyFactory;
  }
).createProxyMiddleware;

// bastion/ is a standalone sub-project with its own node_modules (including
// `jsonwebtoken`), not reachable from this root-level test file — hand-roll a
// minimal HS256 signer good enough for sessions.ts's real jwt.verify(), the
// same way proxy-headless-auth.test.ts does.
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signHS256Jwt(payload: Record<string, unknown>, secret: string, expiresInSeconds = 8 * 60 * 60): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}`;
  return `${signingInput}.${base64url(createHmac("sha256", secret).update(signingInput).digest())}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeConfig(overrides: Partial<Config>): Config {
  return {
    port: 3000,
    jwtSecret: "test-jwt-secret",
    authProvider: "simple",
    bosImage: "browseros:latest",
    volumeBase: "/user-data",
    maxConcurrentInstances: 50,
    bosBaseRef: "main",
    bosRepoPath: "/bos-src",
    bosVolumeBaseHost: "/tmp/bos-volume-base-host",
    dataDir: "/tmp/bos-bastion-data",
    bosNet: "bos-net",
    keycloakIssuer: "",
    keycloakClientId: "",
    keycloakClientSecret: "",
    keycloakUsernameClaim: "preferred_username",
    keycloakAdminRole: "bos-admin",
    publicUrl: "http://localhost:3000",
    ...overrides,
  };
}

// sessions.ts's cookie name — not exported, so pinned here as a literal; a
// mismatch makes every session test below fail loudly rather than silently.
const SESSION_COOKIE_NAME = "bos_session";

async function makeUsersRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = path.join(os.tmpdir(), `bos-proxy-ws-test-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(root, { recursive: true });
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function writeIndex(
  usersRoot: string,
  username: string,
  entries: Record<string, { service: string; createdAt: string }>,
): Promise<void> {
  const file = path.join(usersRoot, username, "data", "system", "credentials-index.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, entries }, null, 2));
}

/** A minimal `IncomingMessage` stand-in for an upgrade request. Only `headers`
 *  and `url` are ever touched on this path. Returned as the real type so the
 *  production signature is exercised unchanged. */
function makeUpgradeReq(headers: Record<string, string>, url = "/__supervisor/services/terminal/ws"): http.IncomingMessage {
  return { headers: { ...headers }, url, method: "GET" } as unknown as http.IncomingMessage;
}

interface CapturedSocket {
  socket: net.Socket;
  /** Everything written to the client socket, i.e. the refusal response. */
  written: () => string;
  /** Resolves once the handler closes the socket (`end`, or `destroy` on an
   *  already-dead one) — the terminal action on every refusal path, so tests
   *  never need a fixed sleep. */
  done: Promise<void>;
}

function makeSocket(): CapturedSocket {
  const chunks: string[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const record = (chunk?: string | Buffer): void => {
    if (chunk === undefined) return;
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };
  const socket = {
    writable: true,
    write(chunk: string | Buffer) {
      record(chunk);
      return true;
    },
    end(chunk?: string | Buffer) {
      record(chunk);
      resolveDone();
      return socket;
    },
    destroy() {
      resolveDone();
    },
  } as unknown as net.Socket;
  return { socket, written: () => chunks.join(""), done };
}

/** Drive one upgrade through the proxy's real server-level handler by attaching
 *  it to a throwaway server and emitting the event exactly as Node would. */
function emitUpgrade(
  proxy: ReturnType<typeof createBosProxy>,
  req: http.IncomingMessage,
  captured: CapturedSocket,
): void {
  const server = new http.Server();
  proxy.upgrade(server);
  server.emit("upgrade", req, captured.socket, Buffer.alloc(0));
}

function statusLine(response: string): string {
  return response.split("\r\n")[0] ?? "";
}

function basicAuthHeader(secret: string): string {
  return `Basic ${Buffer.from(`ignored-username:${secret}`, "utf8").toString("base64")}`;
}

test.describe("createBosProxy — WebSocket upgrade authentication", () => {
  test("an unauthenticated upgrade is refused with 401 and never dispatched", async () => {
    const proxy = createBosProxy(makeConfig({}));
    const captured = makeSocket();
    const req = makeUpgradeReq({});

    emitUpgrade(proxy, req, captured);
    await captured.done;

    // 401, not 503: refused at authentication, so routing was never reached.
    expect(statusLine(captured.written())).toContain("401");
    expect(captured.written()).toContain('WWW-Authenticate: Basic realm="BrowserOS"');
    // Nothing was ever asserted about who this is, and no target was chosen.
    expect(req.headers["x-bos-auth-scope"]).toBeUndefined();
    expect(req.headers["x-bos-username"]).toBeUndefined();
  });

  test("client-supplied claim headers are stripped, never trusted, on an unauthenticated upgrade", async () => {
    const proxy = createBosProxy(makeConfig({}));
    const captured = makeSocket();
    // Forging both claim headers AND a username must not fabricate a session.
    const req = makeUpgradeReq({
      "x-bos-auth-scope": "session",
      "x-bos-auth-role": "admin",
      "x-bos-username": "victim",
    });

    emitUpgrade(proxy, req, captured);
    await captured.done;

    expect(statusLine(captured.written())).toContain("401");
    expect(req.headers["x-bos-auth-scope"]).toBeUndefined();
    expect(req.headers["x-bos-auth-role"]).toBeUndefined();
    // x-bos-username is only ever set by dispatchUpgrade, which was not reached.
    expect(req.headers["x-bos-username"]).toBe("victim");
  });

  test("a garbage / wrongly-signed session cookie is refused with 401", async () => {
    const cfg = makeConfig({});
    const proxy = createBosProxy(cfg);
    const captured = makeSocket();
    const forged = signHS256Jwt({ username: "alice", isAdmin: true }, "not-the-real-secret");
    const req = makeUpgradeReq({ cookie: `${SESSION_COOKIE_NAME}=${forged}` });

    emitUpgrade(proxy, req, captured);
    await captured.done;

    expect(statusLine(captured.written())).toContain("401");
    expect(req.headers["x-bos-auth-scope"]).toBeUndefined();
  });

  test("a valid session cookie authenticates from the RAW Cookie header and reaches dispatch", async () => {
    const cfg = makeConfig({});
    const proxy = createBosProxy(cfg);
    const captured = makeSocket();
    const token = signHS256Jwt({ username: "alice", isAdmin: false }, cfg.jwtSecret);
    // Deliberately alongside other cookies, and with no cookie-parser in front
    // — server.on("upgrade") fires outside the Express middleware chain.
    const req = makeUpgradeReq({ cookie: `other=1; ${SESSION_COOKIE_NAME}=${token}; theme=dark` });

    emitUpgrade(proxy, req, captured);
    await captured.done;

    // 503, not 401: authentication succeeded and dispatch was reached; no
    // container is running for "alice" in a unit test, so it declines there.
    expect(statusLine(captured.written())).toContain("503");
    expect(req.headers["x-bos-auth-scope"]).toBe("session");
    expect(req.headers["x-bos-auth-role"]).toBeUndefined();
  });

  test("an admin session propagates the admin role claim on the upgrade path too", async () => {
    const cfg = makeConfig({});
    const proxy = createBosProxy(cfg);
    const captured = makeSocket();
    const token = signHS256Jwt({ username: "root", isAdmin: true }, cfg.jwtSecret);
    const req = makeUpgradeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` });

    emitUpgrade(proxy, req, captured);
    await captured.done;

    expect(statusLine(captured.written())).toContain("503");
    expect(req.headers["x-bos-auth-scope"]).toBe("session");
    expect(req.headers["x-bos-auth-role"]).toBe("admin");
  });

  test("a headless per-service secret routes the upgrade to the minting user", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secret = "ws-upgrade-secret";
      await writeIndex(root, "alice", {
        [sha256(secret)]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
      });
      const proxy = createBosProxy(makeConfig({ volumeBase: root }));
      const captured = makeSocket();
      const req = makeUpgradeReq({ authorization: basicAuthHeader(secret) });

      emitUpgrade(proxy, req, captured);
      await captured.done;

      // Reached dispatch for the minting user (503), not refused (401).
      expect(statusLine(captured.written())).toContain("503");
      // Same claim shape the HTTP path asserts: a secret is never a session.
      expect(req.headers["x-bos-auth-scope"]).toBe("secret:test-example-protocol-a");
      expect(req.headers.authorization).toBe(`Bearer ${secret}`);
    } finally {
      await cleanup();
    }
  });

  test("a secret that was never minted is refused with 401, not routed", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      await writeIndex(root, "alice", {
        [sha256("the-real-secret")]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
      });
      const proxy = createBosProxy(makeConfig({ volumeBase: root }));
      const captured = makeSocket();
      const req = makeUpgradeReq({ authorization: basicAuthHeader("never-minted") });

      emitUpgrade(proxy, req, captured);
      await captured.done;

      expect(statusLine(captured.written())).toContain("401");
      expect(req.headers["x-bos-auth-scope"]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

test.describe("createBosProxy — single upgrade listener (no fan-out)", () => {
  test("attaches exactly one upgrade listener to the server", () => {
    const proxy = createBosProxy(makeConfig({}));
    const server = new http.Server();
    expect(server.listenerCount("upgrade")).toBe(0);

    proxy.upgrade(server);

    // Exactly one, and it stays one: every upgrade is authenticated once and
    // dispatched to a single container, rather than fanned out to one listener
    // per user.
    expect(server.listenerCount("upgrade")).toBe(1);
  });

  test("http-proxy-middleware self-subscribes an upgrade listener when ws:true — which is why the per-user proxies must not", async () => {
    // Pins the exact library behaviour behind the incident, independently of
    // bastion's own code: with `ws: true`, the FIRST HTTP request through a
    // proxy instance silently registers a server-level "upgrade" listener
    // (dist/http-proxy-middleware.js's catchUpgradeRequest). One instance per
    // user therefore meant one unauthenticated fan-out listener per user.
    // proxy.ts sets `ws: false` precisely to prevent this; if a future edit
    // flips it back, this test documents what that re-introduces.
    const upstream = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const counts: Record<string, number> = {};
    const servers: http.Server[] = [];

    for (const ws of [true, false]) {
      const middleware = createProxyMiddleware({ target: `http://127.0.0.1:${upstreamPort}`, ws });
      const gateway = http.createServer((req, res) => void middleware(req, res, () => {}));
      servers.push(gateway);
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      const port = (gateway.address() as net.AddressInfo).port;

      // One ordinary HTTP request is all it takes to trigger the subscription.
      await new Promise<void>((resolve, reject) => {
        const r = http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        r.on("error", reject);
      });

      counts[String(ws)] = gateway.listenerCount("upgrade");
    }

    await Promise.all([
      ...servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);

    expect(counts["true"]).toBe(1);  // self-subscribed behind our back
    expect(counts["false"]).toBe(0); // what proxy.ts relies on
  });
});
