// Reproduction: DataFS reported "hardlink isolation available" on a
// deployment where hardlink isolation is structurally impossible, and the
// clone layer then silently degraded every clone to a full byte copy.
//
// `testHardlink(dir)` created BOTH the source file and its link inside
// `dataDir()`:
//
//     const a = await tmpName(dir, ".a");
//     const b = `${a}.lnk`;
//     await fs.writeFile(a, "x");
//     await fs.link(a, b);          // same directory, same mount — always OK
//
// The operation it is standing in for is not that. A clone links
// `dataDir()/…` to `<cloneRoot>/<branch>/…`, and in the bastion deployment
// those are two separate bind mounts:
//
//     bind …/alex/data        -> /app/data
//     bind …/alex/data-clones -> /data-clones
//
// `link(2)` refuses to cross mounts even when the superblock is the same, so
// EVERY file failed with EXDEV:
//
//     cp: cannot create hard link '/data-clones/bos/never-written.provisioning/…'
//       to '/app/data/.agent-backups/…': Invalid cross-device link
//
// The probe never saw it, `auto` kept choosing the hardlink farm, and
// `provisionClone`'s catch turned each 8.5 GB "free" clone into an 8.5 GB
// copy. 21 abandoned branches later the production disk was full.
//
// A capability probe has to perform the capability. These tests cross a real
// filesystem boundary because that is the only place the bug exists.
//
//   npm run test:unit -- tests/datafs/probe-clone-root.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from "fs";
import { tmpdir } from "os";

/**
 * A directory that is on a DIFFERENT filesystem from `from`, or null when this
 * machine offers none. Verified by actually attempting the link rather than by
 * comparing `statfs` — the kernel rule being reproduced (`do_linkat` rejecting
 * a cross-MOUNT link) is not visible in a filesystem type.
 */
function crossDeviceRoot(from: string): string | null {
  const probeSrc = join(from, ".xdev-probe");
  writeFileSync(probeSrc, "x");
  try {
    for (const candidate of ["/dev/shm", "/run/shm", tmpdir()]) {
      let root: string;
      try {
        root = mkdtempSync(join(candidate, "bos-xdev-"));
      } catch {
        continue; // candidate absent or not writable on this machine
      }
      const link = join(root, "probe.lnk");
      try {
        linkSync(probeSrc, link);
        unlinkSync(link); // same device after all — not the pair we need
        rmSync(root, { recursive: true, force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EXDEV") return root;
        rmSync(root, { recursive: true, force: true });
      }
    }
    return null;
  } finally {
    rmSync(probeSrc, { force: true });
  }
}

function useDirs() {
  // Under the repo tree, NOT the temp dir: the point is to put the data dir
  // and the clone root on different filesystems, and on most machines the
  // repo checkout and /dev/shm qualify while two temp dirs do not.
  const root = mkdtempSync(join(process.cwd(), "test-results", "datafs-probe-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const prevData = process.env.BOS_DATA_DIR;
  const prevClones = process.env.BOS_DATA_CLONES;
  process.env.BOS_DATA_DIR = data;
  return {
    root,
    data,
    setCloneRoot(dir: string) {
      process.env.BOS_DATA_CLONES = dir;
    },
    cleanup() {
      if (prevData === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = prevData;
      if (prevClones === undefined) delete process.env.BOS_DATA_CLONES;
      else process.env.BOS_DATA_CLONES = prevClones;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("hardlink capability is probed against the CLONE ROOT — a cross-mount clone root reports hardlink: false", async () => {
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const dirs = useDirs();
  try {
    const foreign = crossDeviceRoot(dirs.data);
    test.skip(
      foreign === null,
      "no second filesystem available on this machine (tried /dev/shm, /run/shm, os.tmpdir) — the cross-mount case cannot be reproduced here",
    );
    dirs.setCloneRoot(foreign!);

    const { detectDataFsCapabilities } = await import("../../src/lib/datafs/probe");
    const caps = await detectDataFsCapabilities(true);

    expect(caps.cloneRoot).toBe(foreign);
    expect(
      caps.hardlink,
      "linking from the data dir INTO the clone root fails with EXDEV here, so the hardlink farm cannot work — reporting it as available is what silently turned every clone into a full copy",
    ).toBe(false);
    expect(
      caps.methods,
      "a method that cannot work must not be offered; `copy` is the universal floor",
    ).not.toContain("hardlink");
  } finally {
    dirs.cleanup();
  }
});

test("a clone root on the SAME filesystem still reports hardlink: true", async () => {
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const dirs = useDirs();
  try {
    // The normal standalone layout: data/ and the clone root are siblings.
    const clones = join(dirs.root, "bos-data-clones");
    mkdirSync(clones, { recursive: true });
    dirs.setCloneRoot(clones);

    const { detectDataFsCapabilities } = await import("../../src/lib/datafs/probe");
    const caps = await detectDataFsCapabilities(true);

    expect(caps.cloneRoot).toBe(clones);
    expect(caps.hardlink, "a same-filesystem clone root can hardlink — the fix must not report false for everyone").toBe(true);
    expect(caps.methods).toContain("hardlink");
  } finally {
    dirs.cleanup();
  }
});

test("a clone root that does not exist yet is created and probed, not reported as incapable", async () => {
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const dirs = useDirs();
  try {
    // First boot: BOS_DATA_CLONES points somewhere nothing has created yet.
    // Answering "hardlink: false" here would permanently downgrade a perfectly
    // capable deployment to full copies on the strength of a missing mkdir.
    const clones = join(dirs.root, "not-created-yet", "clones");
    dirs.setCloneRoot(clones);

    const { detectDataFsCapabilities } = await import("../../src/lib/datafs/probe");
    const caps = await detectDataFsCapabilities(true);

    expect(caps.hardlink).toBe(true);
    expect(caps.methods).toContain("hardlink");
  } finally {
    dirs.cleanup();
  }
});

test("the probe leaves nothing behind in either the data dir or the clone root", async () => {
  mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
  const dirs = useDirs();
  try {
    const clones = join(dirs.root, "bos-data-clones");
    mkdirSync(clones, { recursive: true });
    dirs.setCloneRoot(clones);

    const { detectDataFsCapabilities } = await import("../../src/lib/datafs/probe");
    await detectDataFsCapabilities(true);

    const { readdirSync } = await import("fs");
    // Assert on the probe's OWN scratch pattern rather than "the directory is
    // empty": emptiness is a claim about everything in the world, and under a
    // loaded full-suite run something unrelated in the same worker can land
    // here and turn a real contract into a flake.
    const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(".dfsprobe-"));
    expect(leftovers(dirs.data), "probe scratch files must not accumulate in the user's data dir").toEqual([]);
    expect(leftovers(clones), "…nor in the clone root").toEqual([]);
  } finally {
    dirs.cleanup();
  }
});
