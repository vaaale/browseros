// Unit tests for SpecFS commit-message helpers (027-vfs-specfs).
import { test } from "@playwright/test";
import { strict as assert } from "node:assert";
import { boundDiff, deterministicMessage } from "../../src/os/fs/commit-message";

const diffFor = (...files: string[]) =>
  files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@\n+x`).join("\n");

test("deterministic message: no files", () => {
  assert.equal(deterministicMessage(""), "spec: update");
});

test("deterministic message: single file names it", () => {
  assert.equal(deterministicMessage(diffFor("95-app/spec.md")), "spec: update 95-app/spec.md");
});

test("deterministic message: multiple files summarizes with a count", () => {
  const msg = deterministicMessage(diffFor("a/spec.md", "b/plan.md", "c/tasks.md"));
  assert.match(msg, /^spec: update 3 files \(a\/spec\.md, …\)$/);
});

test("boundDiff passes short diffs through unchanged", () => {
  const d = diffFor("x/spec.md");
  assert.equal(boundDiff(d), d);
});

test("boundDiff truncates oversized diffs with a marker", () => {
  const big = "x".repeat(20_000);
  const out = boundDiff(big);
  assert.ok(out.length < big.length);
  assert.match(out, /\[diff truncated\]$/);
});
