// Unit tests for the FS-backend path jail (027-vfs-specfs). The jail NEUTRALIZES
// traversal by clamping to the root (matching the pre-027 resolveSafe semantics),
// so the security property to assert is "result never escapes root".
import { test } from "@playwright/test";
import { strict as assert } from "node:assert";
import path from "node:path";
import { jailResolve } from "../../src/os/path-jail";

const ROOT = "/srv/root";
const underRoot = (p: string) => p === ROOT || p.startsWith(ROOT + path.sep);

test("resolves a normal relative path under the root", () => {
  assert.equal(jailResolve(ROOT, "a/b.txt"), path.join(ROOT, "a/b.txt"));
});

test("empty path resolves to the root", () => {
  assert.equal(jailResolve(ROOT, ""), ROOT);
});

test("clamps a parent-traversal attempt back under the root", () => {
  assert.ok(underRoot(jailResolve(ROOT, "../etc/passwd")));
  assert.ok(underRoot(jailResolve(ROOT, "a/../../etc")));
  assert.ok(underRoot(jailResolve(ROOT, "../../../../etc/shadow")));
});

test("collapses harmless internal traversal", () => {
  assert.equal(jailResolve(ROOT, "a/../b"), path.join(ROOT, "b"));
});
