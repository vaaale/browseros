// Unit tests for the Supervisor's OAuth refresh + auth-retry logic
// (tools/supervisor/lib/git-auth.mjs), added after a real production
// incident: the Supervisor had no way to refresh an expired GitLab OAuth
// token, so every `begin` failed until BOS's own main app happened to
// refresh it via unrelated git activity. `git-auth.mjs` is dependency-light
// (Node built-ins + fetch only) and takes `dataDir`/`git` as explicit
// parameters rather than reading frozen module-level config, so — unlike
// the config.mjs-based Supervisor tests in this directory (see
// _helpers.mjs's header comment) — every test here can safely use its own
// isolated temp dataDir within the SAME process.
//   node --test tests/supervisor/git-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setEncrypted, getStoredOAuthToken } = await import("../../tools/supervisor/lib/secrets.mjs");
const { refreshOAuthToken, resolveRemoteTokenFresh, fetchOriginWithAuth } = await import("../../tools/supervisor/lib/git-auth.mjs");

function makeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "git-auth-test-"));
  writeFileSync(join(dataDir, ".integrations-key"), randomBytes(32));
  return dataDir;
}

function seedOAuth(dataDir, { accessToken = "old-token", refreshToken = "refresh-1", expiresAt } = {}) {
  setEncrypted(dataDir, "git_remote_oauth:gitlab:client", { clientId: "client-id", clientSecret: "client-secret" });
  setEncrypted(dataDir, "git_remote:oauth:gitlab", {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  });
}

function seedRemoteConfig(dataDir) {
  mkdirSync(join(dataDir, "config"), { recursive: true });
  writeFileSync(
    join(dataDir, "config", "git-remotes.json"),
    JSON.stringify([{ name: "origin", provider: "gitlab", authType: "oauth" }]),
  );
}

// Stubs global.fetch to answer GitLab's /oauth/token endpoint. Returns a
// call counter so tests can assert whether a refresh was actually attempted.
function stubTokenEndpoint(responder) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : "" });
    return responder(calls.length);
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("refreshOAuthToken: success persists the new token and mirrors expiry onto git-remotes.json", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { expiresAt: Date.now() - 1000 });
    seedRemoteConfig(dataDir);
    const { restore } = stubTokenEndpoint(() => jsonResponse(200, { access_token: "new-token", refresh_token: "refresh-2", expires_in: 3600 }));
    try {
      const result = await refreshOAuthToken(dataDir, "gitlab");
      assert.equal(result.ok, true);
      assert.equal(result.accessToken, "new-token");

      const stored = getStoredOAuthToken(dataDir, "gitlab");
      assert.equal(stored.access_token, "new-token");
      assert.equal(stored.refresh_token, "refresh-2");
      assert.ok(stored.expires_at > Date.now());

      const configs = JSON.parse(readFileSync(join(dataDir, "config", "git-remotes.json"), "utf8"));
      assert.equal(configs[0].oauthTokenExpiresAt, stored.expires_at);
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("refreshOAuthToken: no refresh_token on file short-circuits to reconnectRequired without calling the token endpoint", async () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote_oauth:gitlab:client", { clientId: "client-id", clientSecret: "client-secret" });
    setEncrypted(dataDir, "git_remote:oauth:gitlab", { access_token: "old-token" }); // no refresh_token
    const { calls, restore } = stubTokenEndpoint(() => jsonResponse(200, {}));
    try {
      const result = await refreshOAuthToken(dataDir, "gitlab");
      assert.equal(result.ok, false);
      assert.equal(result.reconnectRequired, true);
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteTokenFresh: refreshes when the stored token is near/past expiry", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { expiresAt: Date.now() - 1000 });
    const { calls, restore } = stubTokenEndpoint(() => jsonResponse(200, { access_token: "refreshed-token", refresh_token: "refresh-2", expires_in: 3600 }));
    try {
      const result = await resolveRemoteTokenFresh(dataDir, "origin", "oauth", "gitlab");
      assert.equal(calls.length, 1);
      assert.equal(result.token, "refreshed-token");
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteTokenFresh: does NOT refresh when the stored token is comfortably valid", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { expiresAt: Date.now() + 3_600_000 });
    const { calls, restore } = stubTokenEndpoint(() => jsonResponse(200, { access_token: "should-not-be-used", expires_in: 3600 }));
    try {
      const result = await resolveRemoteTokenFresh(dataDir, "origin", "oauth", "gitlab");
      assert.equal(calls.length, 0);
      assert.equal(result.token, "old-token");
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fetchOriginWithAuth: auth failure -> refresh succeeds -> retry succeeds", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { expiresAt: Date.now() + 3_600_000 }); // valid at start — the FETCH itself is what fails
    const { restore } = stubTokenEndpoint(() => jsonResponse(200, { access_token: "new-token", refresh_token: "refresh-2", expires_in: 3600 }));
    try {
      const gitCalls = [];
      const git = async (args, cwd, env) => {
        gitCalls.push({ args, cwd, env });
        if (gitCalls.length === 1) throw new Error("Command failed: git fetch\nfatal: Authentication failed for 'https://gitlab.example/repo.git'");
        return "ok";
      };
      const remote = { name: "origin", authType: "oauth", provider: "gitlab" };
      const result = await fetchOriginWithAuth(dataDir, git, remote, ["fetch", "origin", "claude"], "/repo");
      assert.equal(result, "ok");
      assert.equal(gitCalls.length, 2);
      assert.equal(gitCalls[0].env.BOS_GIT_CRED_PASSWORD, "old-token");
      assert.equal(gitCalls[1].env.BOS_GIT_CRED_PASSWORD, "new-token");
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fetchOriginWithAuth: auth failure -> refresh itself fails -> one composed error, no retry", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { expiresAt: Date.now() + 3_600_000 });
    const { restore } = stubTokenEndpoint(() => jsonResponse(400, { error: "server_error", error_description: "token endpoint is down" }));
    try {
      const gitCalls = [];
      const git = async (args, cwd, env) => {
        gitCalls.push({ args, cwd, env });
        throw new Error("fatal: Authentication failed");
      };
      const remote = { name: "origin", authType: "oauth", provider: "gitlab" };
      await assert.rejects(
        fetchOriginWithAuth(dataDir, git, remote, ["fetch", "origin", "claude"], "/repo"),
        (err) => {
          assert.match(err.message, /Authentication failed/);
          assert.match(err.message, /after refresh attempt/);
          assert.match(err.message, /token endpoint is down/);
          return true;
        },
      );
      assert.equal(gitCalls.length, 1, "must not retry when the refresh attempt itself failed");
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fetchOriginWithAuth: invalid_grant race — a concurrent refresher already rotated the token, re-read succeeds", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { accessToken: "old-token", expiresAt: Date.now() + 3_600_000 });
    let fetchCalls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => {
      fetchCalls += 1;
      // Simulate: our refresh_token was already consumed by a concurrent
      // refresher elsewhere, whose successful refresh already wrote a NEW
      // token to disk before we read the response.
      seedOAuth(dataDir, { accessToken: "concurrently-refreshed-token", expiresAt: Date.now() + 3_600_000 });
      return jsonResponse(400, { error: "invalid_grant", error_description: "refresh token already used" });
    };
    try {
      const gitCalls = [];
      const git = async (args, cwd, env) => {
        gitCalls.push({ args, cwd, env });
        if (gitCalls.length === 1) throw new Error("fatal: Authentication failed");
        return "ok";
      };
      const remote = { name: "origin", authType: "oauth", provider: "gitlab" };
      const result = await fetchOriginWithAuth(dataDir, git, remote, ["fetch", "origin", "claude"], "/repo");
      assert.equal(result, "ok");
      assert.equal(fetchCalls, 1);
      assert.equal(gitCalls.length, 2);
      assert.equal(gitCalls[1].env.BOS_GIT_CRED_PASSWORD, "concurrently-refreshed-token");
    } finally {
      global.fetch = realFetch;
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fetchOriginWithAuth: invalid_grant with NO external rotation — throws a reconnect-required error, no retry", async () => {
  const dataDir = makeDataDir();
  try {
    seedOAuth(dataDir, { accessToken: "old-token", expiresAt: Date.now() + 3_600_000 });
    const { restore } = stubTokenEndpoint(() => jsonResponse(400, { error: "invalid_grant", error_description: "refresh token revoked" }));
    try {
      const gitCalls = [];
      const git = async (args, cwd, env) => {
        gitCalls.push({ args, cwd, env });
        throw new Error("fatal: Authentication failed");
      };
      const remote = { name: "origin", authType: "oauth", provider: "gitlab" };
      await assert.rejects(
        fetchOriginWithAuth(dataDir, git, remote, ["fetch", "origin", "claude"], "/repo"),
        (err) => {
          assert.match(err.message, /reconnect required/i);
          return true;
        },
      );
      assert.equal(gitCalls.length, 1);
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fetchOriginWithAuth: no credential configured at all — fails immediately, never attempts a refresh", async () => {
  const dataDir = makeDataDir();
  try {
    const { calls, restore } = stubTokenEndpoint(() => jsonResponse(200, {}));
    try {
      const gitCalls = [];
      const git = async (args, cwd, env) => {
        gitCalls.push({ args, cwd, env });
        throw new Error("fatal: could not read Username for 'https://gitlab.example': No such device or address");
      };
      const remote = { name: "origin", authType: "ssh" };
      await assert.rejects(fetchOriginWithAuth(dataDir, git, remote, ["fetch", "origin", "claude"], "/repo"), /could not read Username/);
      assert.equal(gitCalls.length, 1);
      assert.equal(calls.length, 0, "no OAuth remote — refreshing would be meaningless");
    } finally {
      restore();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
