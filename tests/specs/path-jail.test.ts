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

test("throws rather than trust a malformed (non-canonical) root — the caller contract is an absolute, canonical root", () => {
  // A relative root can never be a string-prefix of path.resolve()'s absolute
  // output, so this exercises the explicit escape guard directly rather than
  // relying on relPath alone to reach it (relPath traversal is neutralized
  // before this check ever sees it — see the test above).
  assert.throws(() => jailResolve("relative/root", "file.txt"), /escapes the filesystem root/);
});
