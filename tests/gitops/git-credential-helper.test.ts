// git credential helper unit tests
//   npx playwright test -c playwright.unit.config.ts tests/gitops/git-credential-helper.test.ts
//
// Exercises the git credential helper that makes OAuth-protected remotes
// authenticate under GIT_TERMINAL_PROMPT=0. Imports only the pure
// (non-"server-only") half so it avoids the server import chain, then writes
// the real HELPER_SOURCE to a temp file and executes it exactly as git would.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  HELPER_SOURCE,
  buildCredentialArgs,
  buildCredentialEnv,
  CRED_ENV_USERNAME,
  CRED_ENV_PASSWORD,
} from "../../src/lib/gitops/git-credential-helper-script";

const TMP = path.join(os.tmpdir(), `bos-cred-test-${randomBytes(6).toString("hex")}`);
let scriptPath = "";

test.beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
  scriptPath = path.join(TMP, "credential-helper.cjs");
  await fs.writeFile(scriptPath, HELPER_SOURCE, { mode: 0o700 });
});

test.afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// Run the helper exactly as git does: `node <script> <op>` with stdin holding
// the credential request and the token supplied via the environment.
function runHelper(
  op: string,
  env: Record<string, string>,
  stdin = "protocol=https\nhost=gitlab.example.com\n\n",
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, op], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("close", (code) => resolve({ stdout, code: code ?? 0 }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ── The materialised helper script speaks the git credential protocol ─────────

test.describe("credential helper script (git protocol)", () => {
  test("emits username/password on `get` when a token is present", async () => {
    const { stdout } = await runHelper("get", { [CRED_ENV_PASSWORD]: "secret-tok" });
    expect(stdout).toContain("username=oauth2");
    expect(stdout).toContain("password=secret-tok");
  });

  test("honours a custom username", async () => {
    const { stdout } = await runHelper("get", {
      [CRED_ENV_USERNAME]: "x-access-token",
      [CRED_ENV_PASSWORD]: "secret-tok",
    });
    expect(stdout).toContain("username=x-access-token");
    expect(stdout).toContain("password=secret-tok");
  });

  test("emits nothing when no token is present", async () => {
    const { stdout } = await runHelper("get", { [CRED_ENV_PASSWORD]: "" });
    expect(stdout).toBe("");
  });

  test("is a no-op for `store` / `erase` operations", async () => {
    const store = await runHelper("store", { [CRED_ENV_PASSWORD]: "secret-tok" });
    const erase = await runHelper("erase", { [CRED_ENV_PASSWORD]: "secret-tok" });
    expect(store.stdout).toBe("");
    expect(erase.stdout).toBe("");
  });
});

// ── Credential config construction ────────────────────────────────────────────

test.describe("buildCredentialArgs", () => {
  test("clears the inherited helper then registers ours as a shell command", () => {
    const args = buildCredentialArgs("/usr/bin/node", "/data/.git-cred/credential-helper.cjs");
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe("credential.helper=");
    expect(args[2]).toBe("-c");
    expect(args[3]).toBe('credential.helper=!"/usr/bin/node" "/data/.git-cred/credential-helper.cjs"');
  });

  test("quotes paths so spaces survive the shell", () => {
    const args = buildCredentialArgs("/usr/bin/node", "/my data/helper.cjs");
    expect(args[3]).toContain('"/my data/helper.cjs"');
  });
});

test.describe("buildCredentialEnv", () => {
  test("passes the token as the password with a default oauth2 username", () => {
    const env = buildCredentialEnv("tok-123");
    expect(env[CRED_ENV_USERNAME]).toBe("oauth2");
    expect(env[CRED_ENV_PASSWORD]).toBe("tok-123");
  });

  test("accepts a custom username", () => {
    const env = buildCredentialEnv("tok-123", "x-access-token");
    expect(env[CRED_ENV_USERNAME]).toBe("x-access-token");
  });
});
