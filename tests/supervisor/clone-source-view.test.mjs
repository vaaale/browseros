// Making the hardlink farm actually work in the bastion.
//
// `link(2)` refuses to cross a MOUNT, even when both paths sit on one
// filesystem. The bastion gives each container the data dir and the clone root
// as two separate bind mounts of two sibling host directories:
//
//     …/<user>/data        -> /app/data
//     …/<user>/data-clones -> /data-clones
//
// so `cp -al /app/data /data-clones/bos/<branch>` fails with EXDEV on every
// single file, and every "free" clone is a full copy of the user's data dir.
//
// Two directories can only share a mount if one mount covers both, and the
// only directory covering these two is their parent `…/<user>`. So either the
// data dir is re-addressed through that parent — which means changing
// BOS_DATA_DIR for every existing container, and every absolute symlink under
// `data/system/*` written by installItemLink with it — or the Supervisor is
// given a SECOND PATH to the same directory, used only for cloning.
//
// This is the second. `BOS_CLONE_SOURCE` names the single-mount view of the
// canonical data dir. It is not a second data dir and nothing else may use it:
// it exists because the kernel's cross-mount rule is about PATHS, not about
// the bytes they reach. The bastion adds one bind (`…/<user>` -> /bos) and
// sets `BOS_CLONE_SOURCE=/bos/data` alongside `BOS_DATA_CLONES=/bos/data-clones`;
// BOS itself keeps using /app/data and every existing symlink keeps resolving.
//
// Unset — the standalone layout — it is exactly CANONICAL_DATA, and nothing
// about this changes.
//
//   node --test tests/supervisor/clone-source-view.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, statSync, mkdtempSync, rmSync, linkSync, unlinkSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSupervisorEnv } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("clone-source-");

// A second path to the SAME directory, the way `/bos/data` and `/app/data`
// both reach `…/<user>/data`. A symlink is the closest a unit test can get to
// a bind mount without root, and it is enough FOR WHAT THIS FILE TESTS: which
// PATH the clone layer sources from and probes with.
//
// It cannot test the thing the option exists for. A symlink resolves to the
// same vfsmount, so hardlinking across one always works — only a real second
// bind mount reproduces the EXDEV. That was verified by hand on the
// production host instead, same image and same directories, varying only the
// mounts:
//
//   A. -v …/alex/data:/app/data  -v …/alex/data-clones:/data-clones
//        ln /app/data/x /data-clones/y
//        -> ln: Invalid cross-device link
//
//   B. -v …/alex:/bos
//        ln /bos/data/x /bos/data-clones/y
//        -> OK, nlink=2, same inode
//        cp -al /bos/data /bos/data-clones/bos/<b>  ->  2s, 8.5G apparent, 0 MB consumed
//        (a 1.1 GB model file: orig ino=1168312 nlink=2, clone ino=1168312)
//
// If this layout is ever changed, re-run that comparison — no unit test in
// this repo can catch it regressing.
const altRoot = mkdtempSync(join(tmpdir(), "clone-source-alt-"));
const altView = join(altRoot, "data-view");
symlinkSync(env.dataDir, altView, "dir");

const { provisionClone } = await import("../../tools/supervisor/lib/worktree.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;

mkdirSync(join(env.dataDir, "vfs", "Documents"), { recursive: true });
writeFileSync(join(env.dataDir, "vfs", "Documents", "hello.txt"), "canonical content\n");
mkdirSync(join(env.dataDir, "config"), { recursive: true });
writeFileSync(join(env.dataDir, "config", "datafs.json"), JSON.stringify({ method: "auto" }, null, 2));

/** A directory on a different filesystem from `from`, or null. */
function crossDeviceRoot(from) {
  const probeSrc = join(from, ".xdev-probe");
  writeFileSync(probeSrc, "x");
  try {
    for (const candidate of ["/dev/shm", "/run/shm", tmpdir()]) {
      let root;
      try {
        root = mkdtempSync(join(candidate, "bos-src-xdev-"));
      } catch {
        continue;
      }
      const link = join(root, "probe.lnk");
      try {
        linkSync(probeSrc, link);
        unlinkSync(link);
        rmSync(root, { recursive: true, force: true });
      } catch (e) {
        if (e?.code === "EXDEV") return root;
        rmSync(root, { recursive: true, force: true });
      }
    }
    return null;
  } finally {
    rmSync(probeSrc, { force: true });
  }
}

const XDEV = crossDeviceRoot(env.dataDir);
const cleanup = [];

test("unset: the clone source is CANONICAL_DATA and the hardlink farm works as before", async () => {
  delete process.env.BOS_CLONE_SOURCE;
  const target = join(env.clones, "default-source");
  const result = await provisionClone(target);

  assert.equal(result.method, "hardlink");
  assert.equal(
    statSync(join(target, "vfs", "Documents", "hello.txt")).ino,
    statSync(join(env.dataDir, "vfs", "Documents", "hello.txt")).ino,
    "the standalone layout must be completely unaffected by this option existing",
  );
});

test("set: the clone is sourced through the alternate view, and still shares inodes with the canonical data", async () => {
  process.env.BOS_CLONE_SOURCE = altView;
  try {
    const target = join(env.clones, "alt-source");
    const result = await provisionClone(target);

    assert.equal(result.method, "hardlink");
    assert.equal(
      await readFile(join(target, "vfs", "Documents", "hello.txt"), "utf8"),
      "canonical content\n",
      "the alternate view addresses the SAME directory — the clone's content must be identical",
    );
    // The inode identity is the point: a second path to the same bytes still
    // hardlinks to those bytes, which is what makes a clone cost metadata.
    assert.equal(
      statSync(join(target, "vfs", "Documents", "hello.txt")).ino,
      statSync(join(env.dataDir, "vfs", "Documents", "hello.txt")).ino,
    );
  } finally {
    delete process.env.BOS_CLONE_SOURCE;
  }
});

test("the hardlink probe is performed FROM the clone source, not from CANONICAL_DATA", async (t) => {
  if (!XDEV) return t.skip("no second filesystem on this machine — a cross-mount source cannot be reproduced here");
  // A clone source on a different filesystem from the target: linking from it
  // is impossible, while linking from CANONICAL_DATA would succeed. If the
  // probe still used CANONICAL_DATA it would answer "hardlink" and `cp -al`
  // would then fail on every file — precisely the production failure, just
  // with the paths swapped.
  const foreignSource = mkdtempSync(join(XDEV, "source-"));
  cleanup.push(foreignSource);
  mkdirSync(join(foreignSource, "vfs", "Documents"), { recursive: true });
  writeFileSync(join(foreignSource, "vfs", "Documents", "hello.txt"), "from the foreign source\n");
  mkdirSync(join(foreignSource, "config"), { recursive: true });
  writeFileSync(join(foreignSource, "config", "datafs.json"), JSON.stringify({ method: "auto" }, null, 2));

  process.env.BOS_CLONE_SOURCE = foreignSource;
  try {
    const target = join(env.clones, "foreign-source");
    const result = await provisionClone(target);

    assert.equal(result.method, "copy", "the probe must reflect the source actually being cloned from");
    assert.equal(
      await readFile(join(target, "vfs", "Documents", "hello.txt"), "utf8"),
      "from the foreign source\n",
      "and the content must come from that source too",
    );
  } finally {
    delete process.env.BOS_CLONE_SOURCE;
  }
});

test.after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  if (XDEV) rmSync(XDEV, { recursive: true, force: true });
  rmSync(altRoot, { recursive: true, force: true });
  env.cleanup();
});
