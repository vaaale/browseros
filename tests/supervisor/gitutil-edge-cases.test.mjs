// Unit tests for the remaining branches of tools/supervisor/lib/gitutil.mjs
// not already exercised incidentally by other suites: refExists's genuine
// (non-"not found") failure rethrow, mutate's failure-is-recorded-not-thrown
// contract, and requireFeatureBranch's throw.
//   node --test tests/supervisor/gitutil-edge-cases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { refExists, mutate, isFeatureBranch, requireFeatureBranch } = await import("../../tools/supervisor/lib/gitutil.mjs");

test("refExists: a genuine git failure (not a 'not found' condition) rethrows rather than being read as false", async () => {
  await assert.rejects(refExists("/nonexistent/not-a-repo-at-all", "refs/heads/main"));
});

test("mutate: a throwing fn is recorded into warnings and never rethrown", async () => {
  const warnings = [];
  const result = await mutate("do a risky thing", () => {
    throw new Error("boom");
  }, warnings);
  assert.equal(result, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /do a risky thing failed: boom/);
});

test("mutate: a throwing fn with no warnings array supplied still does not throw", async () => {
  const result = await mutate("do a risky thing", () => {
    throw new Error("boom");
  });
  assert.equal(result, undefined);
});

test("mutate: a successful fn's return value passes through untouched", async () => {
  const result = await mutate("do a safe thing", () => "ok", []);
  assert.equal(result, "ok");
});

test("isFeatureBranch / requireFeatureBranch: rejects the base branch itself, non-strings, and malformed slugs", () => {
  assert.equal(isFeatureBranch("bos/claude", "bos/claude"), false, "the base branch itself is never a feature branch");
  assert.equal(isFeatureBranch(null, "claude"), false);
  assert.equal(isFeatureBranch("bos/Has-Upper", "claude"), false, "slug must be lowercase");
  assert.equal(isFeatureBranch("bos/a-b-c-d-e", "claude"), false, "at most 4 dash-separated segments");
  assert.equal(isFeatureBranch("bos/good-name", "claude"), true);

  assert.throws(() => requireFeatureBranch("not-a-feature-branch", "claude"), /must match bos\/<kebab-name>/);
  assert.equal(requireFeatureBranch("bos/good-name", "claude"), "bos/good-name");
});
