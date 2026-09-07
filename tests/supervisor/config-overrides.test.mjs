// Verifies config.mjs actually honors its BOS_* env overrides (own-process —
// see _helpers.mjs's header comment on why: config.mjs freezes these at
// first import). Covers the BASE_DEV truthy-regex branch and the
// REUSE_BASE_PORT set branch, both left at their default (falsy) in
// config.test.mjs.
//   node --test tests/supervisor/config-overrides.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BOS_BASE_DEV = "true";
process.env.BOS_ACTIVE_REUSE_PORT = "4123";
process.env.BOS_PUBLIC_PORT = "9999";
process.env.BOS_PORT_BASE = "3111";
process.env.BOS_PORT_POOL_SIZE = "5";

const config = await import("../../tools/supervisor/lib/config.mjs");

test("config: BOS_BASE_DEV=true parses truthy", () => {
  assert.equal(config.BASE_DEV, true);
});

test("config: BOS_ACTIVE_REUSE_PORT is parsed to a number", () => {
  assert.equal(config.REUSE_BASE_PORT, 4123);
});

test("config: BOS_PUBLIC_PORT / BOS_PORT_BASE / BOS_PORT_POOL_SIZE overrides apply", () => {
  assert.equal(config.PUBLIC_PORT, 9999);
  assert.equal(config.BASE_PORT, 3111);
  assert.equal(config.POOL_SIZE, 5);
});
