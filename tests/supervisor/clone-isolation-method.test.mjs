// Reproduction: "hardlink isolation" silently performed full byte copies.
//
// `provisionClone` resolved the isolation method from data/config/datafs.json
// and, for the default "auto", ran the hardlink farm hopefully:
//
//     else await run(["-al", CANONICAL_DATA, staging]);
//     } catch (e) {
//       slog("warn", "provision", `${method} clone of ${target} failed, falling back to plain copy: ...`);
//       await run(["-a", CANONICAL_DATA, staging]);
//     }
//
// In the bastion deployment the data dir and the clone root are two separate
// bind mounts, and `link(2)` refuses to cross a mount even on one filesystem.
// So `cp -al` failed on EVERY file and the catch quietly turned a metadata
// operation into an 8.5 GB copy — once per branch, forever, until the
// production disk filled.
//
// Two things were wrong and both are tested here:
//
//   1. The method was never verified against the actual clone target, so a
//      configuration that cannot work was chosen anyway.
//   2. The failure was masked. `exec`'s 8 MB maxBuffer overflowed on the flood
//      of per-file errors, so 16 of the 20 log entries on the production box
//      read "stderr maxBuffer length exceeded" instead of the real cause,
//      "Invalid cross-device link". The reason a fallback fired must survive.
//
//   node --test tests/supervisor/clone-isolation-method.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, statSync, mkdtempSync, rmSync, linkSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSupervisorEnv } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("clone-isolation-");
const { provisionClone } = await import("../../tools/supervisor/lib/worktree.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;

mkdirSync(join(env.dataDir, "vfs", "Documents"), { recursive: true });
writeFileSync(join(env.dataDir, "vfs", "Documents", "hello.txt"), "canonical content\n");

function setMethod(method) {
  mkdirSync(join(env.dataDir, "config"), { recursive: true });
  writeFileSync(join(env.dataDir, "config", "datafs.json"), JSON.stringify({ method }, null, 2));
}

/** A clone root on a DIFFERENT filesystem from the data dir, reproducing the
 *  bastion's two-bind-mounts layout, or null if this machine has none. */
function crossDeviceRoot() {
  const probeSrc = join(env.dataDir, ".xdev-probe");
  writeFileSync(probeSrc, "x");
  try {
    for (const candidate of ["/dev/shm", "/run/shm", tmpdir()]) {
      let root;
      try {
        root = mkdtempSync(join(candidate, "bos-clone-xdev-"));
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

const XDEV_ROOT = crossDeviceRoot();
const cleanupRoots = [];

test("auto on a same-filesystem clone root really hardlinks — the clone SHARES inodes with the data dir", async () => {
  setMethod("auto");
  const target = join(env.clones, "auto-same-fs");
  const result = await provisionClone(target);

  assert.equal(result.method, "hardlink", "auto must pick the hardlink farm where it genuinely works");
  const cloned = statSync(join(target, "vfs", "Documents", "hello.txt"));
  const canonical = statSync(join(env.dataDir, "vfs", "Documents", "hello.txt"));
  // The whole point of the hardlink farm. `nlink > 1` and a matching inode is
  // the only evidence that a clone cost metadata rather than bytes — the
  // production clones had nlink=1 and distinct inodes, which is how an
  // "isolation" feature quietly consumed 8.5 GB per branch.
  assert.equal(cloned.ino, canonical.ino, "a hardlink clone must share the inode, not copy the bytes");
  assert.ok(cloned.nlink > 1, `expected the shared inode to have >1 link, got nlink=${cloned.nlink}`);
});

test("auto on a cross-MOUNT clone root does not choose a method that cannot work", async (t) => {
  if (!XDEV_ROOT) return t.skip("no second filesystem on this machine — the bastion's cross-mount layout cannot be reproduced here");
  setMethod("auto");
  const root = mkdtempSync(join(XDEV_ROOT, "clones-"));
  cleanupRoots.push(root);
  const target = join(root, "auto-cross-fs");

  const result = await provisionClone(target);

  assert.equal(result.method, "copy", "hardlinks cannot cross a mount here, so auto must resolve to copy rather than try and fall back");
  assert.equal(result.degradedFrom, undefined, "resolving `auto` correctly is not a degradation — nothing failed");
  assert.equal(
    await readFile(join(target, "vfs", "Documents", "hello.txt"), "utf8"),
    "canonical content\n",
    "the clone must still be complete and correct",
  );
});

test("an explicit hardlink setting that cannot work reports the degradation TO THE CALLER, with the real reason", async (t) => {
  if (!XDEV_ROOT) return t.skip("no second filesystem on this machine");
  setMethod("hardlink");
  const root = mkdtempSync(join(XDEV_ROOT, "clones-"));
  cleanupRoots.push(root);
  const target = join(root, "explicit-hardlink-cross-fs");

  const result = await provisionClone(target);

  assert.equal(result.method, "copy");
  // Logging alone was the bug: the Supervisor warned and carried on, and the
  // 8.5 GB-per-branch cost of that "warning" was invisible to everything that
  // could have acted on it.
  assert.equal(result.degradedFrom, "hardlink", "the caller must be told the configured method was not the one used");
  assert.match(
    result.reason ?? "",
    /cross-device|EXDEV/i,
    `the REASON must be the real one, not a masked "stderr maxBuffer length exceeded" — got: ${result.reason}`,
  );
  assert.equal(await readFile(join(target, "vfs", "Documents", "hello.txt"), "utf8"), "canonical content\n");
});

test("an explicit copy setting is honoured without pretending it is anything else", async () => {
  setMethod("copy");
  const target = join(env.clones, "explicit-copy");
  const result = await provisionClone(target);

  assert.equal(result.method, "copy");
  assert.equal(result.degradedFrom, undefined);
  const cloned = statSync(join(target, "vfs", "Documents", "hello.txt"));
  const canonical = statSync(join(env.dataDir, "vfs", "Documents", "hello.txt"));
  assert.notEqual(cloned.ino, canonical.ino, "an explicit copy must be a real copy");
});

test("an already-provisioned clone is still never re-copied, and says so", async () => {
  setMethod("auto");
  const target = join(env.clones, "idempotent");
  await provisionClone(target);
  writeFileSync(join(target, "DRIFT"), "the preview wrote this itself\n");

  const second = await provisionClone(target);

  assert.equal(second.method, "existing", "a no-op provision must not claim to have cloned anything");
  assert.equal(existsSync(join(target, "DRIFT")), true, "local drift must survive");
});

test.after(() => {
  for (const r of cleanupRoots) rmSync(r, { recursive: true, force: true });
  if (XDEV_ROOT) rmSync(XDEV_ROOT, { recursive: true, force: true });
  env.cleanup();
});
