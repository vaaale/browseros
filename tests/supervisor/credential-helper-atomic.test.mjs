// Regression test for tools/supervisor/lib/secrets.mjs's ensureCredentialHelper
// (via buildGitCredential): the credential-helper script used to be written
// with a plain, direct `fs.writeFileSync` — under hardlink-farm data-clone
// isolation, this path can share its inode with base's and every preview's
// own copy until first written, so an in-place write would be visible,
// mid-write, to all of them at once (the atomic-writes contract the whole
// data-isolation design otherwise depends on). Fixed to reuse this same
// file's own `writeFileAtomic` (temp + rename).
//
//   node --test tests/supervisor/credential-helper-atomic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildGitCredential } = await import("../../tools/supervisor/lib/secrets.mjs");

test("buildGitCredential: writes the helper script atomically (no leftover temp file), executable, correct content", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cred-helper-atomic-"));
  try {
    const { args, env } = buildGitCredential(dataDir, "secret-token-123");

    const dir = join(dataDir, ".git-cred");
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ["credential-helper.cjs"], "no leftover .tmp file after an atomic write");

    const scriptPath = join(dir, "credential-helper.cjs");
    const content = readFileSync(scriptPath, "utf8");
    assert.match(content, /BOS_GIT_CRED_USERNAME/);
    assert.match(content, /BOS_GIT_CRED_PASSWORD/);

    const mode = statSync(scriptPath).mode & 0o777;
    assert.equal(mode, 0o700, "must be executable only by its owner");

    assert.ok(args.some((a) => typeof a === "string" && a.includes(scriptPath)), "the credential.helper arg must point at the written script");
    assert.equal(env.BOS_GIT_CRED_USERNAME, "oauth2");
    assert.equal(env.BOS_GIT_CRED_PASSWORD, "secret-token-123");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("buildGitCredential: idempotent — a second call with the same source doesn't corrupt or duplicate the script", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cred-helper-idempotent-"));
  try {
    const first = buildGitCredential(dataDir, "token-a");
    const scriptPath = join(dataDir, ".git-cred", "credential-helper.cjs");
    const contentAfterFirst = readFileSync(scriptPath, "utf8");

    const second = buildGitCredential(dataDir, "token-b"); // different TOKEN, same helper SOURCE
    const contentAfterSecond = readFileSync(scriptPath, "utf8");

    assert.equal(contentAfterFirst, contentAfterSecond, "the helper script's source never depends on the token — must be byte-identical");
    assert.equal(readdirSync(join(dataDir, ".git-cred")).length, 1, "still exactly one file — no duplicate/leftover from the second write");
    assert.equal(second.env.BOS_GIT_CRED_PASSWORD, "token-b", "each call's own returned env still carries its own token");
    assert.notEqual(first.env.BOS_GIT_CRED_PASSWORD, second.env.BOS_GIT_CRED_PASSWORD);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
