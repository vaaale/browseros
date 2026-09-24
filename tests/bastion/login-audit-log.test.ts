// bastion/src/audit-log.ts — login audit trail (simple provider only).
//   npm run test:unit -- tests/bastion/login-audit-log.test.ts
//
// Drives the REAL auth router (createAuthRouter) over loopback HTTP against a
// stub AuthProvider, so what is asserted is what a deployed bastion actually
// writes — not a re-implementation of the record shape. The provider stub is
// the only seam: no Docker, no bcrypt cost, no live Keycloak.

import { test, expect } from "@playwright/test";
import express from "express";
import http from "node:http";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AuthProvider, UserRecord } from "../../bastion/src/auth/index";
import type { Config } from "../../bastion/src/config";
import { createAuthRouter } from "../../bastion/src/routers/auth";
import { initAuditLog, auditLogPath, type AuditRecord } from "../../bastion/src/audit-log";

const PASSWORDS: Record<string, string> = { alice: "correct-horse", root: "hunter2" };

/** In-memory stand-in for SimpleProvider — same contract, no bcrypt/file I/O. */
function stubProvider(): AuthProvider {
  const users: Record<string, UserRecord> = {
    alice: { username: "alice", isAdmin: false },
    root: { username: "root", isAdmin: true },
  };
  return {
    authenticate: async (username, password) =>
      PASSWORDS[username] === password ? users[username] : null,
    getUser: async (username) => users[username] ?? null,
    listUsers: async () => Object.values(users),
    createUser: async () => {},
    deleteUser: async () => {},
    updatePassword: async () => {},
    setAdmin: async () => {},
    adminExists: async () => true,
  };
}

function makeConfig(dataDir: string, authProvider: "simple" | "keycloak"): Config {
  return {
    dataDir,
    authProvider,
    jwtSecret: "test-secret-value",
    publicUrl: "http://localhost",
  } as unknown as Config;
}

/** "" for an absent log (the assertion several tests make); any other read
 *  failure is a genuine fault and must not look like "no attempts recorded". */
async function readLog(file: string): Promise<string> {
  return fs.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
}

interface Harness {
  post: (body: unknown, headers?: Record<string, string>) => Promise<number>;
  records: () => Promise<AuditRecord[]>;
  rawLog: () => Promise<string>;
  logFile: string;
  close: () => Promise<void>;
}

async function harness(authProvider: "simple" | "keycloak" = "simple"): Promise<Harness> {
  const dataDir = path.join(os.tmpdir(), `bos-login-audit-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(dataDir, { recursive: true });
  const cfg = makeConfig(dataDir, authProvider);
  initAuditLog(cfg);
  const logFile = auditLogPath();

  const app = express();
  app.use(createAuthRouter(cfg, stubProvider()));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  return {
    logFile,
    post: async (body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "audit-test/1.0", ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
      });
      return res.status;
    },
    rawLog: async () => readLog(logFile),
    records: async () => {
      const raw = await readLog(logFile);
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test.describe("login audit log", () => {
  test("records a successful login with its outcome, admin flag and client metadata", async () => {
    const h = await harness();
    try {
      expect(await h.post({ username: "root", password: "hunter2" })).toBe(200);
      const [rec, ...rest] = await h.records();
      expect(rest).toHaveLength(0);
      expect(rec.event).toBe("login");
      expect(rec.outcome).toBe("success");
      expect(rec.username).toBe("root");
      expect(rec.isAdmin).toBe(true);
      expect(rec.reason).toBeNull();
      expect(rec.userAgent).toBe("audit-test/1.0");
      expect(rec.ip).toContain("127.0.0.1");
      expect(Date.parse(rec.ts)).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  test("records every failure mode with a distinguishing reason", async () => {
    const h = await harness();
    try {
      expect(await h.post({ username: "alice", password: "wrong" })).toBe(401);
      expect(await h.post({ username: "nobody", password: "whatever" })).toBe(401);
      expect(await h.post({ username: "alice" })).toBe(400);
      expect(await h.post({})).toBe(400);

      const recs = await h.records();
      expect(recs.map((r) => r.reason)).toEqual([
        "bad_password",
        "unknown_user",
        "missing_credentials",
        "missing_credentials",
      ]);
      expect(recs.every((r) => r.outcome === "failure")).toBe(true);
      expect(recs[1].username).toBe("nobody"); // the attempted name, even though no such user
      expect(recs[3].username).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("never writes the submitted password", async () => {
    const h = await harness();
    try {
      await h.post({ username: "alice", password: "correct-horse" });
      await h.post({ username: "alice", password: "s3cret-guess" });
      const raw = await h.rawLog();
      expect(raw).not.toContain("correct-horse");
      expect(raw).not.toContain("s3cret-guess");
    } finally {
      await h.close();
    }
  });

  test("records X-Forwarded-For separately from the connection address", async () => {
    const h = await harness();
    try {
      await h.post({ username: "alice", password: "correct-horse" }, {
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      });
      const [rec] = await h.records();
      expect(rec.forwardedFor).toBe("203.0.113.9, 10.0.0.1");
      expect(rec.ip).toContain("127.0.0.1");
    } finally {
      await h.close();
    }
  });

  test("a forged username cannot inject an extra log line", async () => {
    const h = await harness();
    try {
      await h.post({ username: 'x"}\n{"event":"login","outcome":"success","username":"root', password: "nope" });
      const raw = await h.rawLog();
      expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
      const [rec] = await h.records();
      expect(rec.outcome).toBe("failure");
      expect(rec.username).toContain("\n"); // escaped in the file, intact once parsed
    } finally {
      await h.close();
    }
  });

  test("writes nothing when the provider is not 'simple'", async () => {
    const h = await harness("keycloak");
    try {
      // POST /login is not the Keycloak login path; whatever it answers, the
      // bastion must not pretend to own an audit trail it cannot see.
      await h.post({ username: "alice", password: "correct-horse" });
      await h.post({ username: "nobody", password: "whatever" });
      expect(fsSync.existsSync(h.logFile)).toBe(false);
    } finally {
      await h.close();
    }
  });

  test("rotates the log instead of growing without bound", async () => {
    const h = await harness();
    try {
      await fs.mkdir(path.dirname(h.logFile), { recursive: true });
      await fs.writeFile(h.logFile, Buffer.alloc(5 * 1024 * 1024, 0x2e)); // at the rotation threshold
      await h.post({ username: "alice", password: "correct-horse" });

      expect(fsSync.existsSync(`${h.logFile}.1`)).toBe(true);
      expect(fsSync.statSync(`${h.logFile}.1`).size).toBe(5 * 1024 * 1024);
      const recs = await h.records();
      expect(recs).toHaveLength(1); // fresh active file, holding only the new attempt
      expect(recs[0].outcome).toBe("success");
    } finally {
      await h.close();
    }
  });
});
