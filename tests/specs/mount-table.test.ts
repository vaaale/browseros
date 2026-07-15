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
