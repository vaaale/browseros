// Unit tests for the VFS mount-resolution logic (027-vfs-specfs).
// Browser-less; run via `npx playwright test -c playwright.unit.config.ts`.
import { test } from "@playwright/test";
import { strict as assert } from "node:assert";
import path from "node:path";
import { resolveMountPath, normalizeMountPrefix } from "../../src/os/mount-table";

const norm = (p: string) => path.posix.normalize("/" + (p || "/"));

test("matches a mounted sub-path and strips the prefix", () => {
  assert.deepEqual(resolveMountPath("/Documents/Specs/95/spec.md", ["/Documents/Specs"]), {
    prefix: "/Documents/Specs",
    rel: "95/spec.md",
  });
});

test("exact prefix yields empty rel", () => {
  assert.deepEqual(resolveMountPath("/Documents/Specs", ["/Documents/Specs"]), {
    prefix: "/Documents/Specs",
    rel: "",
  });
});

test("prefers the longest matching prefix", () => {
  const r = resolveMountPath("/Documents/Specs/x", ["/Documents", "/Documents/Specs"]);
  assert.equal(r?.prefix, "/Documents/Specs");
  assert.equal(r?.rel, "x");
});

test("does not match a sibling that merely shares a prefix string", () => {
  assert.equal(resolveMountPath("/Documents/SpecsExtra/x", ["/Documents/Specs"]), null);
});

test("unmounted path returns null (falls through to local FS)", () => {
  assert.equal(resolveMountPath("/Pictures/a.png", ["/Documents/Specs"]), null);
});

test("traversal is neutralized by normalization before matching", () => {
  const attacked = norm("/Documents/Specs/../../etc/passwd"); // => /etc/passwd
  assert.equal(resolveMountPath(attacked, ["/Documents/Specs"]), null);

  const inside = norm("/Documents/Specs/a/../b"); // => /Documents/Specs/b
  const r = resolveMountPath(inside, ["/Documents/Specs"]);
  assert.equal(r?.rel, "b");
  assert.ok(!r?.rel.includes(".."));
});

test("normalizeMountPrefix canonicalizes leading/trailing slashes", () => {
  assert.equal(normalizeMountPrefix("Documents/Specs/"), "/Documents/Specs");
  assert.equal(normalizeMountPrefix("/Documents/Specs"), "/Documents/Specs");
});

test("normalizeMountPrefix falls back to root for an empty prefix", () => {
  assert.equal(normalizeMountPrefix(""), "/");
});

test("a shorter prefix seen AFTER the longest match is skipped, not swapped in", () => {
  // Registration order shouldn't matter — only length. Here the longer prefix
  // is checked first and already wins; the later, shorter match must hit the
  // `continue` guard rather than displacing it.
  const r = resolveMountPath("/Documents/Specs/x", ["/Documents/Specs", "/Documents"]);
  assert.equal(r?.prefix, "/Documents/Specs");
  assert.equal(r?.rel, "x");
});

test("a mount's ANCESTOR directory lists its mounted children", async () => {
  // `/Methods` is not a mount; `/Methods/<pack>/templates` is. Listing the
  // parent found nothing, so an agent browsing for installed methods saw an
  // empty directory and reasonably concluded none were installed — it checked
  // three times before giving up and reading skills to infer them instead.
  const { registerMount, unregisterMount, list } = await import("../../src/os/vfs");
  const { LocalFS } = await import("../../src/os/fs/local-fs");
  // A PRIVATE prefix, not /Methods: the real mount table is a module global and
  // the built-in pack registers /Methods/spec-kit/templates, so asserting over
  // /Methods would depend on ambient state and pass or fail by test order.
  const backend = new LocalFS(path.join(process.cwd(), "seed"));
  registerMount("/MountAncestorTest/alpha/templates", backend);
  registerMount("/MountAncestorTest/beta/templates", backend);
  try {
    const names = (await list("/MountAncestorTest")).map((e) => e.name).sort();
    assert.deepEqual(names, ["alpha", "beta"], "both are discoverable by browsing the ancestor");
    assert.deepEqual((await list("/MountAncestorTest/alpha")).map((e) => e.name), ["templates"]);
  } finally {
    unregisterMount("/MountAncestorTest/alpha/templates");
    unregisterMount("/MountAncestorTest/beta/templates");
  }
});
