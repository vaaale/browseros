// 045 T002 — unregisterMount (FR-012, FR-016).
//
// Until 045 the VFS mount table (src/os/vfs.ts) was append-and-replace only:
// registerMount findIndex/push/replaces, findMount reads, and nothing ever
// spliced. That was fine while mounts were registered once at startup and
// nothing was ever uninstalled. A method pack mounts its templates at install
// and MUST un-mount them at uninstall, or an uninstalled pack's templates stay
// resolvable — which reads to a user as "the pack is still installed".
//
// This is a core-OS change (plan.md R4), so it is tested on its own terms
// rather than only through the method layer that motivated it.
//   npm run test:unit -- tests/specs/vfs-unmount.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import * as vfs from "../../src/os/vfs";
import { LocalFS } from "../../src/os/fs/local-fs";

/** A backend rooted at a fresh dir holding one file. */
function backendWith(dir: string, name: string, body: string): LocalFS {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "probe.txt"), body);
  return new LocalFS(root);
}

test("unregisterMount removes the mount and its paths fall back to plain VFS", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-unmount-basic");
  try {
    vfs.registerMount("/Methods/demo", backendWith(dir, "demo", "from the mount"));
    expect(await vfs.readText("/Methods/demo/probe.txt")).toBe("from the mount");

    expect(vfs.unregisterMount("/Methods/demo"), "should report that a mount was removed").toBe(true);

    // The backend is gone, so the path now resolves through default VFS
    // behaviour — where nothing was ever written, so the read fails. The
    // point is that it no longer reaches the backend, NOT that it throws:
    // asserting on the error message would pin local-FS wording that has
    // nothing to do with unmounting.
    await expect(vfs.readText("/Methods/demo/probe.txt")).rejects.toThrow();
  } finally {
    cleanup();
  }
});

test("unregisterMount is idempotent — removing an absent prefix is not an error", () => {
  // Uninstall must be safe to run twice, and must not throw when a pack was
  // never fully installed. `false` distinguishes "nothing to remove" from
  // "removed", which a void return would hide: an uninstall that silently
  // no-ops because the mount was never registered is a different bug from one
  // that no-ops because it already ran.
  expect(vfs.unregisterMount("/Methods/never-registered")).toBe(false);
  expect(vfs.unregisterMount("/Methods/never-registered")).toBe(false);
});

test("unregisterMount normalizes its prefix exactly as registerMount does", async () => {
  // registerMount stores normalizeMountPrefix(vfsPrefix); a removal that
  // compared raw strings would fail to find the entry whenever the caller's
  // spelling differed by a trailing slash or a missing leading one — leaving
  // a live mount behind while reporting success to the uninstall path.
  const { dir, cleanup } = useTestDataDir("vfs-unmount-normalize");
  try {
    for (const spelling of ["/Methods/norm/", "Methods/norm", "//Methods//norm"]) {
      vfs.registerMount("/Methods/norm", backendWith(dir, `norm-${spelling.replace(/\W/g, "")}`, "x"));
      expect(vfs.unregisterMount(spelling), `"${spelling}" should resolve to the same mount`).toBe(true);
    }
  } finally {
    cleanup();
  }
});

test("unregistering one mount leaves its siblings and its parent intact", async () => {
  // The table is a flat list and findMount prefers the LONGEST matching
  // prefix. Splicing by index is only correct if it removes exactly the
  // matched entry — a nested prefix sharing a string prefix with its parent
  // is where an off-by-one or a startsWith comparison shows up.
  const { dir, cleanup } = useTestDataDir("vfs-unmount-siblings");
  try {
    vfs.registerMount("/Methods", backendWith(dir, "parent", "parent"));
    vfs.registerMount("/Methods/a", backendWith(dir, "a", "a"));
    vfs.registerMount("/Methods/b", backendWith(dir, "b", "b"));

    expect(vfs.unregisterMount("/Methods/a")).toBe(true);

    expect(await vfs.readText("/Methods/b/probe.txt"), "sibling mount must survive").toBe("b");
    expect(await vfs.readText("/Methods/probe.txt"), "parent mount must survive").toBe("parent");
    // /Methods/a now falls through to the PARENT mount, not to nothing —
    // longest-prefix matching still finds "/Methods".
    await expect(vfs.readText("/Methods/a/probe.txt")).rejects.toThrow();

    vfs.unregisterMount("/Methods");
    vfs.unregisterMount("/Methods/b");
  } finally {
    cleanup();
  }
});

test("a re-registered prefix routes to the NEW backend after an unmount", async () => {
  // The install -> uninstall -> reinstall cycle, which is how a pack upgrade
  // lands. A stale entry left behind by a faulty removal would keep serving
  // the old pack's templates while reporting the new version as installed.
  const { dir, cleanup } = useTestDataDir("vfs-unmount-recycle");
  try {
    vfs.registerMount("/Methods/cycle", backendWith(dir, "v1", "v1"));
    expect(await vfs.readText("/Methods/cycle/probe.txt")).toBe("v1");

    vfs.unregisterMount("/Methods/cycle");
    vfs.registerMount("/Methods/cycle", backendWith(dir, "v2", "v2"));

    expect(await vfs.readText("/Methods/cycle/probe.txt")).toBe("v2");
    vfs.unregisterMount("/Methods/cycle");
  } finally {
    cleanup();
  }
});
