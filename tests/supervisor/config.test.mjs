// Unit tests for tools/supervisor/lib/config.mjs's env-derived defaults and
// helpers. config.mjs reads process.env once at import time (own-process
// convention — see _helpers.mjs's header comment), so this file uses NO
// BOS_* overrides at all: it verifies the un-overridden defaults.
//   node --test tests/supervisor/config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const config = await import("../../tools/supervisor/lib/config.mjs");

test("config: un-overridden defaults", () => {
  assert.equal(config.REPO, process.cwd());
  assert.equal(config.PUBLIC_PORT, 8080);
  assert.equal(config.BASE_PORT, 3000);
  assert.equal(config.POOL_SIZE, 20);
  assert.equal(config.REMOTE, "origin");
  assert.equal(config.HEALTH_TIMEOUT_MS, 120_000);
  assert.equal(config.REUSE_BASE_PORT, null, "no BOS_ACTIVE_REUSE_PORT set");
  assert.equal(config.BASE_DEV, false, "no BOS_BASE_DEV set");
  assert.equal(config.PIN_COOKIE, "bos_pin");
  assert.equal(config.WORKTREES, path.join(config.REPO, "bos-worktrees"));
  assert.equal(config.CANONICAL_DATA, path.join(config.REPO, "data"));
  assert.equal(config.CLONES, path.join(config.REPO, "bos-data-clones"));
  assert.equal(config.APPS_REPO, path.join(config.CANONICAL_DATA, "user-apps"));
  assert.equal(config.SPECS_ROOT, path.join(config.CANONICAL_DATA, "specs"));
});

test("config: worktreePath/clonePath join the branch under the configured roots", () => {
  assert.equal(config.worktreePath("bos/my-feature"), path.join(config.WORKTREES, "bos/my-feature"));
  assert.equal(config.clonePath("bos/my-feature"), path.join(config.CLONES, "bos/my-feature"));
});

test("config: BASE_RESTART_MAX matches the backoff schedule's length", () => {
  assert.equal(config.BASE_RESTART_MAX, config.BASE_RESTART_BACKOFF_MS.length);
  assert.ok(config.BASE_RESTART_MAX > 0);
});
