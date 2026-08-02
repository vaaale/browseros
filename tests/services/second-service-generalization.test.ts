// Generalization proof (034-secrets-authentication, User Story 5, T015).
//   npx playwright test -c playwright.unit.config.ts tests/services/second-service-generalization.test.ts
//
// Everything up through Phase 4 was built and verified against a single
// example service namespace. This test introduces a SECOND, independent
// test-only `service` — distinct from every namespace used elsewhere in this
// feature's own tests — and drives it through the full real pipeline with no
// shortcuts:
//   1. mint a secret via the real service-secrets.ts (BOS side), which writes
//      the real, unaltered credentials-index.json companion file;
//   2. resolve it via the real bastion/src/credential-routing.ts against that
//      same file;
//   3. present it via Basic auth to bastion/src/proxy.ts's real middleware,
//      targeting an arbitrary path Bastion has never special-cased.
//
// No Bastion code is touched or parameterized by this test beyond what Phase
// 4 already introduced — proving FR-008/SC-003/SC-004: adding a new service
// requires zero Bastion changes, and the triggering condition is exclusively
// "Basic auth present, no session," never a path allowlist.
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { _resetKeyCache } from "../../src/lib/integrations/secrets/keyfile";
import { createSecret, verifySecret } from "../../src/lib/secrets/service-secrets";
import { resolveCredential } from "../../bastion/src/credential-routing";
import { createBosProxy } from "../../bastion/src/proxy";
import type { Config } from "../../bastion/src/config";

// A second, independent namespace — distinct from "test-example-protocol-a/b"
// (service-secrets.test.ts), "standalone-test" (verify-secret-standalone.test.ts),
// and "user4-*" secrets (proxy-headless-auth.test.ts). Named for a fictional,
// unrelated protocol to make the "not the example service" property obvious
// from the name alone.
const SECOND_SERVICE = "test-second-independent-service";

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
}

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
  } as unknown as Response;
  return { res, captured, done };
}

// An arbitrary path Bastion has never special-cased for any protocol — the
// point being that neither proxy.ts nor credential-routing.ts ever looks at
// `req.url`/`req.path` at all when making this routing decision (FR-008).
function makeReq(authorizationHeader: string): Request {
  return {
    headers: { authorization: authorizationHeader },
    cookies: {},
    url: "/some/never/special-cased/path/that/proves/nothing/about/routing",
    path: "/some/never/special-cased/path/that/proves/nothing/about/routing",
    method: "PROPFIND",
  } as unknown as Request;
}

const noopNext: NextFunction = () => {};

test.describe("a second, independent service generalizes with zero Bastion changes (US5)", () => {
  test("mint via service-secrets.ts -> resolveCredential() -> proxy.ts all agree, on a path Bastion has never seen", async () => {
    const usersRoot = path.join(os.tmpdir(), `bos-second-service-test-${randomBytes(6).toString("hex")}`);
    const username = "dora";
    const previousDataDir = process.env.BOS_DATA_DIR;

    try {
      // 1. Mint the secret exactly as a real BOS service would: BOS_DATA_DIR
      // points at this fixture user's own data dir, so createSecret's real,
      // unaltered credentials-index.json write lands exactly where Bastion's
      // per-user scan expects it (usersRoot/<username>/data/system/...).
      process.env.BOS_DATA_DIR = path.join(usersRoot, username, "data");
      _resetKeyCache();

      const created = await createSecret(SECOND_SERVICE, "second service label");
      expect(created.service).toBe(SECOND_SERVICE);

      // The mechanism authenticates too, not just routes (FR-002/FR-004) —
      // the full pipeline this feature promises, not merely the routing half.
      const verified = await verifySecret(SECOND_SERVICE, created.rawSecret);
      expect(verified.secretId).toBe(created.secretId);

      // 2. Bastion's routing lookup, directly: resolves to this user + service,
      // reading the exact file service-secrets.ts wrote — no fixture stand-in.
      const resolved = await resolveCredential(created.rawSecret, usersRoot);
      expect(resolved).toEqual({ username, service: SECOND_SERVICE });

      // 3. The full proxy middleware, unmodified beyond what Phase 4 introduced,
      // presented with a path it has never special-cased for any protocol.
      const cfg = makeConfig({ volumeBase: usersRoot });
      const middleware = createBosProxy(cfg);
      const req = makeReq(basicAuthHeader(created.rawSecret));
      const { res, captured, done } = makeRes();
      middleware(req, res, noopNext);
      await done;

      // 503 (not 401) is the routing-succeeded signal used throughout this
      // feature's bastion tests: no container is provisioned for "dora" in
      // this test, so routeToUser's non-HTML branch answers "not ready yet"
      // — which only happens once resolveCredential has already matched.
      expect(captured.statusCode).toBe(503);
      expect(req.headers.authorization).toBe(`Bearer ${created.rawSecret}`);
    } finally {
      _resetKeyCache();
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      await fs.rm(usersRoot, { recursive: true, force: true });
    }
  });

  test("two different services' secrets each resolve to their own correct pairing, no cross-service collision", async () => {
    const usersRoot = path.join(os.tmpdir(), `bos-second-service-collision-test-${randomBytes(6).toString("hex")}`);
    const userA = "alice";
    const userB = "bob";
    const previousDataDir = process.env.BOS_DATA_DIR;

    try {
      process.env.BOS_DATA_DIR = path.join(usersRoot, userA, "data");
      _resetKeyCache();
      const secretA = await createSecret("test-example-protocol-a", "a");

      process.env.BOS_DATA_DIR = path.join(usersRoot, userB, "data");
      _resetKeyCache();
      const secretB = await createSecret(SECOND_SERVICE, "b");

      const resolvedA = await resolveCredential(secretA.rawSecret, usersRoot);
      const resolvedB = await resolveCredential(secretB.rawSecret, usersRoot);

      expect(resolvedA).toEqual({ username: userA, service: "test-example-protocol-a" });
      expect(resolvedB).toEqual({ username: userB, service: SECOND_SERVICE });
    } finally {
      _resetKeyCache();
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      await fs.rm(usersRoot, { recursive: true, force: true });
    }
  });
});
