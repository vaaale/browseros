// bastion/src/proxy.ts headless Basic-auth routing (034-secrets-authentication,
// User Story 4, T013/T014).
//   npx playwright test -c playwright.unit.config.ts tests/bastion/proxy-headless-auth.test.ts
//
// proxy.ts's headless-credential branch (parseBasicAuthSecret →
// resolveCredential → routeToUser) never reads cfg.authProvider at all — it
// only branches on "session absent, Basic auth present" (FR-008). That means
// AUTH_PROVIDER=simple and AUTH_PROVIDER=keycloak are structurally guaranteed
// to behave identically for this path; this test proves it by driving the
// real middleware end-to-end with both configs against the same fixture
// users-root, rather than special-casing either provider (SC-002).
//
// It also proves revocation (FR-009/SC-005): removing a companion index
// entry — exactly what service-secrets.ts's revokeSecret() does — makes the
// very next request using that secret's raw value get rejected (401), never
// routed.

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createBosProxy } from "../../bastion/src/proxy";
import type { Config } from "../../bastion/src/config";

// bastion/ is a standalone sub-project with its own node_modules (including
// `jsonwebtoken`), not reachable from this root-level test file — rather than
// adding it as a root dependency for one test, hand-roll a minimal,
// spec-compliant HS256 signer (base64url(header).base64url(payload).HMAC-SHA256)
// good enough for sessions.ts's real `jwt.verify(token, cfg.jwtSecret)` to
// accept, without needing the library at all.
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signHS256Jwt(payload: Record<string, unknown>, secret: string, expiresInSeconds = 8 * 60 * 60): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}`;
  const signature = base64url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function makeUsersRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = path.join(os.tmpdir(), `bos-proxy-headless-test-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(root, { recursive: true });
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function indexPath(usersRoot: string, username: string): string {
  return path.join(usersRoot, username, "data", "system", "credentials-index.json");
}

async function writeIndex(
  usersRoot: string,
  username: string,
  entries: Record<string, { service: string; createdAt: string }>,
): Promise<void> {
  const file = indexPath(usersRoot, username);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, entries }, null, 2));
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

function basicAuthHeader(secret: string): string {
  return `Basic ${Buffer.from(`ignored-username:${secret}`, "utf8").toString("base64")}`;
}

interface CapturedResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
  redirectLocation?: string;
}

/** A minimal Express Response stand-in. Resolves `done` once the handler
 *  writes a terminal response (json/end/send/redirect), so the test can
 *  await the async resolveCredential().then(...) chain inside proxy.ts
 *  without any fake timers or fixed sleeps. */
function makeRes(): { res: Response; captured: CapturedResponse; done: Promise<void> } {
  const captured: CapturedResponse = { headers: {} };
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      resolveDone();
      return res;
    },
    end() {
      resolveDone();
      return res;
    },
    send(body: unknown) {
      captured.body = body;
      resolveDone();
      return res;
    },
    clearCookie() {
      return res;
    },
    redirect(location: string) {
      captured.statusCode = captured.statusCode ?? 302;
      captured.redirectLocation = location;
      resolveDone();
      return res;
    },
  } as unknown as Response;
  return { res, captured, done };
}

/** `accept` omitted entirely by default — matches a real headless client
 *  (davfs2, curl) far more closely than defaulting to a wildcard Accept
 *  would; the fix under test keys off "Accept doesn't contain text/html",
 *  which is true either way, but an absent header is the more realistic
 *  fixture. */
function makeReq(
  authorizationHeader?: string,
  accept?: string,
  extraHeaders?: Record<string, string>,
  cookies?: Record<string, string>,
): Request {
  const headers: Record<string, string> = { ...extraHeaders };
  if (authorizationHeader !== undefined) headers.authorization = authorizationHeader;
  if (accept !== undefined) headers.accept = accept;
  return {
    headers,
    cookies: cookies ?? {},
  } as unknown as Request;
}

// sessions.ts's cookie name — not exported, so pinned here as a literal; a
// mismatch would make every session-path test below fail immediately (loud,
// not silent), which is an acceptable trade-off against exporting an
// internal constant purely for test convenience.
const SESSION_COOKIE_NAME = "bos_session";

function makeSessionReq(
  payload: { username: string; isAdmin: boolean },
  jwtSecret: string,
  extraHeaders?: Record<string, string>,
): Request {
  const token = signHS256Jwt(payload, jwtSecret);
  return makeReq(undefined, undefined, extraHeaders, { [SESSION_COOKIE_NAME]: token });
}

const noopNext: NextFunction = () => {};

test.describe("createBosProxy headless Basic-auth routing — AUTH_PROVIDER parity (US4)", () => {
  for (const authProvider of ["simple", "keycloak"] as const) {
    test(`AUTH_PROVIDER=${authProvider}: a valid secret routes to the minting user (SC-002)`, async () => {
      const { root, cleanup } = await makeUsersRoot();
      try {
        const secret = `user4-secret-${authProvider}`;
        await writeIndex(root, "alice", {
          [sha256(secret)]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
        });

        const cfg = makeConfig({ authProvider, volumeBase: root });
        const middleware = createBosProxy(cfg);

        const req = makeReq(basicAuthHeader(secret));
        const { res, captured, done } = makeRes();
        middleware(req, res, noopNext);
        await done;

        // No provisioned/running container for "alice" in this test, and the
        // request carries no Accept: text/html — routeToUser's non-HTML
        // branch returns 503 JSON immediately. Reaching that branch (rather
        // than the 401 below) is exactly the signal that routing succeeded:
        // resolveCredential found "alice" and routeToUser was invoked for her.
        expect(captured.statusCode).toBe(503);
        expect((captured.body as { status?: string })?.status).toBe("unknown");
        // FR-007: Bastion rewrites Basic → Bearer and never itself decides validity.
        expect(req.headers.authorization).toBe(`Bearer ${secret}`);
      } finally {
        await cleanup();
      }
    });
  }

  test("a value that was never minted is rejected with 401 + WWW-Authenticate, not routed, under either provider", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      await writeIndex(root, "alice", {
        [sha256("some-other-secret")]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
      });

      for (const authProvider of ["simple", "keycloak"] as const) {
        const cfg = makeConfig({ authProvider, volumeBase: root });
        const middleware = createBosProxy(cfg);

        const req = makeReq(basicAuthHeader("never-minted-value"));
        const { res, captured, done } = makeRes();
        middleware(req, res, noopNext);
        await done;

        expect(captured.statusCode).toBe(401);
        expect(captured.headers["WWW-Authenticate"]).toBe('Basic realm="BrowserOS"');
      }
    } finally {
      await cleanup();
    }
  });

  test("revoking a secret (removing its companion index entry) makes the next presentation rejected (FR-009, SC-005)", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secret = "user4-revocable-secret";
      const hash = sha256(secret);
      await writeIndex(root, "alice", {
        [hash]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
      });

      const cfg = makeConfig({ authProvider: "simple", volumeBase: root });
      const middleware = createBosProxy(cfg);

      // Before revocation: routes successfully (503, not 401 — same signal as above).
      {
        const req = makeReq(basicAuthHeader(secret));
        const { res, captured, done } = makeRes();
        middleware(req, res, noopNext);
        await done;
        expect(captured.statusCode).toBe(503);
      }

      // Revoke: this is exactly what service-secrets.ts's revokeSecret() does
      // to the companion index — remove the entry, leaving the file's other
      // entries (none here) intact.
      await writeIndex(root, "alice", {});

      // After revocation: the very next request using the same raw secret is rejected.
      {
        const req = makeReq(basicAuthHeader(secret));
        const { res, captured, done } = makeRes();
        middleware(req, res, noopNext);
        await done;
        expect(captured.statusCode).toBe(401);
        expect(captured.headers["WWW-Authenticate"]).toBe('Basic realm="BrowserOS"');
      }
    } finally {
      await cleanup();
    }
  });

  // Regression: a WebDAV/curl/any headless client's OPENING request never
  // carries an Authorization header at all (RFC 7617 non-preemptive Basic
  // auth — credentials are withheld until challenged). That request used to
  // fall all the way through to the "no session, no Basic header" branch and
  // get a 302 redirect to /login, which no such client can follow — it just
  // fails, indistinguishably from a request with no credentials configured
  // at all. The fix: only an actual browser navigation (Accept: text/html)
  // gets redirected; anything else gets the same 401 + WWW-Authenticate
  // challenge the "unresolvable secret" branch already issues, so a
  // compliant client retries with Basic auth attached and reaches
  // routeHeadlessCredential instead of dying here.
  test("a credential-less non-HTML request (a headless client's opening probe) gets a 401 challenge, not a 302 to /login", async () => {
    const cfg = makeConfig({ authProvider: "simple" });
    const middleware = createBosProxy(cfg);

    const req = makeReq(undefined, undefined);
    const { res, captured, done } = makeRes();
    middleware(req, res, noopNext);
    await done;

    expect(captured.statusCode).toBe(401);
    expect(captured.headers["WWW-Authenticate"]).toBe('Basic realm="BrowserOS"');
    expect(captured.redirectLocation).toBeUndefined();
  });

  test("a credential-less request that DOES accept text/html (real browser navigation) is still redirected to /login", async () => {
    const cfg = makeConfig({ authProvider: "simple" });
    const middleware = createBosProxy(cfg);

    const req = makeReq(undefined, "text/html,application/xhtml+xml");
    const { res, captured, done } = makeRes();
    middleware(req, res, noopNext);
    await done;

    expect(captured.redirectLocation).toBe("/login");
    expect(captured.headers["WWW-Authenticate"]).toBeUndefined();
  });
});

// Trusted claim propagation: Bastion is the only place that verifies a raw
// credential (session JWT signature, or a secret's hash); everything
// downstream must trust an already-verified, server-asserted claim instead
// of re-deriving trust from "some credential got routed here." These tests
// prove the claim itself is correct and — the actually security-relevant
// part — that a client can never forge it by sending the header directly.
test.describe("createBosProxy — trusted x-bos-auth-scope/x-bos-auth-role claim propagation", () => {
  test("a verified non-admin session gets x-bos-auth-scope: session, no role header", async () => {
    const cfg = makeConfig({ authProvider: "simple" });
    const middleware = createBosProxy(cfg);

    const req = makeSessionReq({ username: "alice", isAdmin: false }, cfg.jwtSecret);
    const { res, captured, done } = makeRes();
    middleware(req, res, noopNext);
    await done;

    expect(req.headers["x-bos-auth-scope"]).toBe("session");
    expect(req.headers["x-bos-auth-role"]).toBeUndefined();
    // No provisioned/running container for "alice" — the same 503-JSON
    // signal used throughout this file to confirm routing actually proceeded
    // (rather than dying earlier in the middleware).
    expect(captured.statusCode).toBe(503);
  });

  test("a verified ADMIN session additionally gets x-bos-auth-role: admin", async () => {
    const cfg = makeConfig({ authProvider: "simple" });
    const middleware = createBosProxy(cfg);

    const req = makeSessionReq({ username: "alice", isAdmin: true }, cfg.jwtSecret);
    const { res, captured, done } = makeRes();
    middleware(req, res, noopNext);
    await done;

    expect(req.headers["x-bos-auth-scope"]).toBe("session");
    expect(req.headers["x-bos-auth-role"]).toBe("admin");
    expect(captured.statusCode).toBe(503);
  });

  test("a routed headless secret gets x-bos-auth-scope: secret:<service>, never 'session'", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secret = "claim-propagation-secret";
      await writeIndex(root, "alice", {
        [sha256(secret)]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
      });

      const cfg = makeConfig({ authProvider: "simple", volumeBase: root });
      const middleware = createBosProxy(cfg);

      const req = makeReq(basicAuthHeader(secret));
      const { res, captured, done } = makeRes();
      middleware(req, res, noopNext);
      await done;

      expect(req.headers["x-bos-auth-scope"]).toBe("secret:test-example-protocol-a");
      expect(req.headers["x-bos-auth-role"]).toBeUndefined();
      expect(captured.statusCode).toBe(503);
    } finally {
      await cleanup();
    }
  });

  test("a client-forged x-bos-auth-scope/x-bos-auth-role is stripped and overwritten — never trusted, even on successful secret routing", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secret = "claim-spoof-attempt-secret";
      await writeIndex(root, "alice", {
        [sha256(secret)]: { service: "test-example-protocol-a", createdAt: new Date().toISOString() },
      });

      const cfg = makeConfig({ authProvider: "simple", volumeBase: root });
      const middleware = createBosProxy(cfg);

      // A real, narrow-purpose secret (routes successfully) PLUS a forged
      // attempt to also claim a session/admin scope directly — exactly what
      // a malicious WebDAV client holding only a file-access token would try
      // in order to escalate to an admin-only surface.
      const req = makeReq(basicAuthHeader(secret), undefined, {
        "x-bos-auth-scope": "session",
        "x-bos-auth-role": "admin",
      });
      const { res, captured, done } = makeRes();
      middleware(req, res, noopNext);
      await done;

      // The server-asserted value always wins — the forged ones never survive.
      expect(req.headers["x-bos-auth-scope"]).toBe("secret:test-example-protocol-a");
      expect(req.headers["x-bos-auth-role"]).toBeUndefined();
      expect(captured.statusCode).toBe(503);
    } finally {
      await cleanup();
    }
  });
});
