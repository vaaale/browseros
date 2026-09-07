// Unit tests for the remaining branches of tools/supervisor/lib/git-auth.mjs
// not already exercised by git-auth.test.mjs: isGitAuthFailure's pattern
// matching, an unknown OAuth provider, missing client credentials, a
// network-level fetch failure during refresh, the plain "token" authType
// path through resolveRemoteTokenFresh, the near-expiry-refresh-fails-but-
// falls-back-to-stale-token path, and a second (post-refresh) retry that
// also fails.
//   node --test tests/supervisor/git-auth-edge-cases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setEncrypted } = await import("../../tools/supervisor/lib/secrets.mjs");
const { isGitAuthFailure, refreshOAuthToken, resolveRemoteTokenFresh, fetchOriginWithAuth } = await import("../../tools/supervisor/lib/git-auth.mjs");

function makeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "git-auth-edge-test-"));
  writeFileSync(join(dataDir, ".integrations-key"), randomBytes(32));
  return dataDir;
}

test("isGitAuthFailure: recognizes every documented auth-failure shape, and rejects an unrelated error", () => {
  for (const msg of [
    "fatal: Authentication failed for 'https://x'",
    "remote: Permission denied",
    "fatal: could not read Username for 'https://x'",
    "fatal: could not read Password for 'https://x'",
    "error: 401 Unauthorized",
    "error: 403 Forbidden",
    "fatal: the token has expired",
    "fatal: bad credentials",
    "fatal: terminal prompts disabled",
  ]) {
    assert.equal(isGitAuthFailure(msg), true, `expected an auth failure: ${msg}`);
  }
  assert.equal(isGitAuthFailure("fatal: not a git repository"), false);
});

test("refreshOAuthToken: unknown provider — no token URL, fails without any fetch", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote_oauth:bitbucket:client", { clientId: "id", clientSecret: "secret" });
    setEncrypted(dataDir, "git_remote:oauth:bitbucket", { access_token: "old", refresh_token: "r1" });
    const result = await refreshOAuthToken(dataDir, "bitbucket");
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown OAuth provider/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("refreshOAuthToken: missing client credentials fails before attempting a fetch", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote:oauth:gitlab", { access_token: "old", refresh_token: "r1" });
    // No git_remote_oauth:gitlab:client entry at all.
    const result = await refreshOAuthToken(dataDir, "gitlab");
    assert.equal(result.ok, false);
    assert.match(result.error, /No OAuth client credentials configured/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("refreshOAuthToken: a network-level fetch failure is reported, not thrown", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote_oauth:gitlab:client", { clientId: "id", clientSecret: "secret" });
    setEncrypted(dataDir, "git_remote:oauth:gitlab", { access_token: "old", refresh_token: "r1" });
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const result = await refreshOAuthToken(dataDir, "gitlab");
      assert.equal(result.ok, false);
      assert.match(result.error, /Refresh request failed: ECONNREFUSED/);
    } finally {
      global.fetch = realFetch;
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteTokenFresh: authType 'token' with no stored credential throws a clear, actionable error", async () => {
  const dataDir = makeDataDir();
  try {
    await assert.rejects(
      resolveRemoteTokenFresh(dataDir, "origin", "token", undefined),
      /No stored credential for remote "origin"/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteTokenFresh: authType 'token' with a stored credential returns it directly, no refresh logic involved", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote:token:origin", { token: "static-token" });
    const result = await resolveRemoteTokenFresh(dataDir, "origin", "token", undefined);
    assert.deepEqual(result, { token: "static-token" });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteTokenFresh: near-expiry refresh fails but a stale token still exists — falls back to it with a warning", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote_oauth:gitlab:client", { clientId: "id", clientSecret: "secret" });
    setEncrypted(dataDir, "git_remote:oauth:gitlab", { access_token: "stale-but-present", refresh_token: "r1", expires_at: Date.now() - 1000 });
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ error: "server_error", error_description: "down" }), { status: 500 });
    try {
      const result = await resolveRemoteTokenFresh(dataDir, "origin", "oauth", "gitlab");
      assert.equal(result.token, "stale-but-present");
    } finally {
      global.fetch = realFetch;
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteTokenFresh: near-expiry with NO stale token and a failed refresh throws", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote_oauth:gitlab:client", { clientId: "id", clientSecret: "secret" });
    setEncrypted(dataDir, "git_remote:oauth:gitlab", { access_token: "", refresh_token: "r1", expires_at: Date.now() - 1000 });
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ error: "server_error", error_description: "down" }), { status: 500 });
    try {
      await assert.rejects(resolveRemoteTokenFresh(dataDir, "origin", "oauth", "gitlab"), /No usable OAuth credential/);
    } finally {
      global.fetch = realFetch;
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fetchOriginWithAuth: refresh succeeds but the retried git call fails for a NEW reason — composed error names both", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote_oauth:gitlab:client", { clientId: "id", clientSecret: "secret" });
    setEncrypted(dataDir, "git_remote:oauth:gitlab", { access_token: "old-token", refresh_token: "r1", expires_at: Date.now() + 3_600_000 });
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ access_token: "new-token", refresh_token: "r2", expires_in: 3600 }), { status: 200 });
    try {
      const gitCalls = [];
      const git = async () => {
        gitCalls.push(1);
        if (gitCalls.length === 1) throw new Error("fatal: Authentication failed");
        throw new Error("fatal: disk full");
      };
      const remote = { name: "origin", authType: "oauth", provider: "gitlab" };
      await assert.rejects(
        fetchOriginWithAuth(dataDir, git, remote, ["fetch", "origin", "claude"], "/repo"),
        (err) => {
          assert.match(err.message, /disk full/);
          assert.match(err.message, /NEW failure, not the original/);
          return true;
        },
      );
      assert.equal(gitCalls.length, 2);
    } finally {
      global.fetch = realFetch;
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
