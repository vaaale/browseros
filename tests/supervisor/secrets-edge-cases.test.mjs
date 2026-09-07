// Unit tests for the remaining branches of tools/supervisor/lib/secrets.mjs
// not already exercised by git-auth.test.mjs: a corrupted/tampered secret
// decrypting to garbage, a plain (non-OAuth) token lookup, and
// updateRemoteOauthExpiry's write-failure and no-match branches.
//   node --test tests/supervisor/secrets-edge-cases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setEncrypted, resolveRemoteToken, updateRemoteOauthExpiry } = await import("../../tools/supervisor/lib/secrets.mjs");

function makeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "secrets-edge-test-"));
  writeFileSync(join(dataDir, ".integrations-key"), randomBytes(32));
  return dataDir;
}

test("resolveRemoteToken: authType 'token' resolves a plain stored token by remote name", () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote:token:origin", { token: "plain-token-abc" });
    const result = resolveRemoteToken(dataDir, "origin", "token", undefined);
    assert.deepEqual(result, { token: "plain-token-abc" });
    assert.equal(resolveRemoteToken(dataDir, "missing-remote", "token", undefined), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteToken: a tampered ciphertext fails to decrypt and resolves to null rather than throwing", () => {
  const dataDir = makeDataDir();
  try {
    setEncrypted(dataDir, "git_remote:token:origin", { token: "plain-token-abc" });
    const secretsPath = join(dataDir, "integrations", "secrets.json");
    const disk = JSON.parse(readFileSync(secretsPath, "utf8"));
    // Flip the tag so AES-GCM auth fails on decrypt.
    disk.entries["git_remote:token:origin"].tag = "AAAAAAAAAAAAAAAAAAAAAA";
    writeFileSync(secretsPath, JSON.stringify(disk, null, 2));
    assert.equal(resolveRemoteToken(dataDir, "origin", "token", undefined), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveRemoteToken: no encryption key on disk resolves to null rather than throwing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "secrets-edge-nokey-"));
  try {
    // A directory where the key file is expected — a non-ENOENT read failure.
    mkdirSync(join(dataDir, ".integrations-key"));
    assert.equal(resolveRemoteToken(dataDir, "origin", "token", undefined), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateRemoteOauthExpiry: no matching provider entry — file untouched", () => {
  const dataDir = makeDataDir();
  try {
    mkdirSync(join(dataDir, "config"), { recursive: true });
    const configPath = join(dataDir, "config", "git-remotes.json");
    const original = JSON.stringify([{ name: "origin", provider: "github" }]);
    writeFileSync(configPath, original);
    updateRemoteOauthExpiry(dataDir, "gitlab", 12345);
    assert.equal(readFileSync(configPath, "utf8"), original, "no gitlab entry to update — file must be byte-identical");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateRemoteOauthExpiry: configs file is not an array — silently ignored", () => {
  const dataDir = makeDataDir();
  try {
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(join(dataDir, "config", "git-remotes.json"), JSON.stringify({ not: "an array" }));
    assert.doesNotThrow(() => updateRemoteOauthExpiry(dataDir, "gitlab", 12345));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateRemoteOauthExpiry: a write failure (unwritable config dir) is swallowed, never thrown", () => {
  if (process.getuid && process.getuid() === 0) return; // root bypasses permission bits — this test needs a real EACCES
  const dataDir = makeDataDir();
  try {
    const configDir = join(dataDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "git-remotes.json"), JSON.stringify([{ name: "origin", provider: "gitlab" }]));
    chmodSync(configDir, 0o555); // read + execute only — writeFileAtomic's tmp-file create must fail
    try {
      assert.doesNotThrow(() => updateRemoteOauthExpiry(dataDir, "gitlab", 99999));
    } finally {
      chmodSync(configDir, 0o755);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
