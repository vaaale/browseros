// Reproduction: a Telegram webhook POST to a Bastion-fronted deployment got a
// 401 with an empty body and never reached any user's container.
//
// Telegram (and webhook providers generally) call the public webhook URL with
// NO session cookie and NO Authorization header — their shared secret rides in
// a provider-specific header (Telegram: `X-Telegram-Bot-Api-Secret-Token`,
// echoed back on every delivery once registered via setWebhook's
// `secret_token`). bastion/src/proxy.ts's middleware only recognised two
// credentials — a session cookie and a Basic-auth secret — so a webhook
// delivery fell through to the credential-less branch:
//
//   res.setHeader("WWW-Authenticate", 'Basic realm="BrowserOS"');
//   res.status(401).end();
//
// which is exactly the observed symptom (Telegram reports 401; curl sees an
// empty response body).
//
// Expected behaviour: a webhook secret presented in a recognised header is
// resolved through the SAME protocol-agnostic credentials-index scan that
// Basic-auth routing uses (034-secrets-authentication), and the request is
// routed to the owning user's container with scope `secret:<service>`. The
// provider's header must travel through UNTOUCHED — the container-side
// webhook handler is the authoritative verifier (same routes-vs-authenticates
// split as FR-007); Bastion only routes.
//
// Run: npm run test:unit -- tests/bastion/proxy-webhook-secret-routing.test.ts

import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createBosProxy } from "../../bastion/src/proxy";
import type { Config } from "../../bastion/src/config";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function makeUsersRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = path.join(os.tmpdir(), `bos-proxy-webhook-test-${randomBytes(6).toString("hex")}`);
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

interface CapturedResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
  redirectLocation?: string;
}

/** Minimal Express Response stand-in — resolves `done` on any terminal write
 *  so the async resolveCredential().then(...) chain can be awaited without
 *  fake timers (same harness as proxy-headless-auth.test.ts). */
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

/** A webhook delivery: no cookie, no Authorization, no Accept: text/html —
 *  only the provider's secret header (when given). */
function makeWebhookReq(extraHeaders?: Record<string, string>): Request {
  return {
    headers: { ...extraHeaders },
    cookies: {},
  } as unknown as Request;
}

const noopNext: NextFunction = () => {};

test.describe("createBosProxy — webhook secret-header routing (Telegram)", () => {
  test("a delivery carrying a minted X-Telegram-Bot-Api-Secret-Token routes to the owning user, header preserved", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secret = "telegram-webhook-routing-secret";
      await writeIndex(root, "alice", {
        [sha256(secret)]: { service: "telegram-webhook", createdAt: new Date().toISOString() },
      });

      const cfg = makeConfig({ volumeBase: root });
      const middleware = createBosProxy(cfg);

      const req = makeWebhookReq({ "x-telegram-bot-api-secret-token": secret });
      const { res, captured, done } = makeRes();
      middleware(req, res, noopNext);
      await done;

      // No provisioned container for "alice" in this test and the request is
      // non-HTML, so routeToUser's non-HTML branch answers 503 JSON — reaching
      // it (instead of the 401 below) proves routing succeeded.
      expect(captured.statusCode).toBe(503);
      expect((captured.body as { status?: string })?.status).toBe("unknown");
      // Scope claim asserted from the index entry's service, never "session".
      expect(req.headers["x-bos-auth-scope"]).toBe("secret:telegram-webhook");
      // The provider's own header must survive untouched — the container-side
      // handler (TelegramBotWebhookHandler.verify) is the authoritative check.
      expect(req.headers["x-telegram-bot-api-secret-token"]).toBe(secret);
      // Unlike Basic routing, no Authorization rewrite happens on this path.
      expect(req.headers.authorization).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("a delivery with an unknown secret token is rejected 401, never routed and never redirected", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      await writeIndex(root, "alice", {
        [sha256("some-other-secret")]: { service: "telegram-webhook", createdAt: new Date().toISOString() },
      });

      const cfg = makeConfig({ volumeBase: root });
      const middleware = createBosProxy(cfg);

      const req = makeWebhookReq({ "x-telegram-bot-api-secret-token": "never-minted-value" });
      const { res, captured, done } = makeRes();
      middleware(req, res, noopNext);
      await done;

      expect(captured.statusCode).toBe(401);
      expect(captured.redirectLocation).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("forged x-bos-auth-scope/x-bos-auth-role on a webhook delivery are stripped and overwritten", async () => {
    const { root, cleanup } = await makeUsersRoot();
    try {
      const secret = "webhook-claim-spoof-secret";
      await writeIndex(root, "alice", {
        [sha256(secret)]: { service: "telegram-webhook", createdAt: new Date().toISOString() },
      });

      const cfg = makeConfig({ volumeBase: root });
      const middleware = createBosProxy(cfg);

      const req = makeWebhookReq({
        "x-telegram-bot-api-secret-token": secret,
        "x-bos-auth-scope": "session",
        "x-bos-auth-role": "admin",
      });
      const { res, captured, done } = makeRes();
      middleware(req, res, noopNext);
      await done;

      expect(req.headers["x-bos-auth-scope"]).toBe("secret:telegram-webhook");
      expect(req.headers["x-bos-auth-role"]).toBeUndefined();
      expect(captured.statusCode).toBe(503);
    } finally {
      await cleanup();
    }
  });

  test("a credential-less delivery with NO secret header still gets the existing 401 challenge (no regression)", async () => {
    const cfg = makeConfig({});
    const middleware = createBosProxy(cfg);

    const req = makeWebhookReq();
    const { res, captured, done } = makeRes();
    middleware(req, res, noopNext);
    await done;

    expect(captured.statusCode).toBe(401);
    expect(captured.headers["WWW-Authenticate"]).toBe('Basic realm="BrowserOS"');
  });
});
