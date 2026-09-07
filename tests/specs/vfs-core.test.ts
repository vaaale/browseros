// Unit tests for the core VFS surface (src/os/vfs.ts) — the mount-dispatch
// glue and the unmounted plain-path fallback for
// list/stat/readText/readBuffer/writeText/writeBuffer/mkdir/remove/rename/
// readStream/writeStream, plus hostPath(), the resolveSafe() escape guard,
// and the CANONICAL_SUBPATHS cross-version root split.
//
// Each FSBackend is unit-tested on its own elsewhere (local-fs.test.ts,
// docs-fs-overlay.test.ts, spec-fs tests, readonly-fs.test.ts). Nothing else
// calls vfs.ts's OWN public functions against a MOUNTED path and confirms
// dispatch actually reaches the registered backend — every existing backend
// test constructs the backend directly, bypassing registerMount()/findMount()
// entirely. This file closes that gap.
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { useTestDataDir } from "../services/_test-env";
import * as vfs from "../../src/os/vfs";
import { LocalFS } from "../../src/os/fs/local-fs";

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- Mount dispatch: registerMount() + a real vfs.* call reaching the backend ----

test("list()/stat() dispatch to a registered mount and rewrite entries to full VFS paths", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-mount-list");
  try {
    const backendRoot = join(dir, "backend");
    mkdirSync(join(backendRoot, "sub"), { recursive: true });
    writeFileSync(join(backendRoot, "a.txt"), "hi");
    vfs.registerMount("/VfsCoreListMount", new LocalFS(backendRoot));

    const entries = await vfs.list("/VfsCoreListMount");
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
    // The backend's own path rooting is discarded — callers always see the
    // full VFS path.
    expect(entries.find((e) => e.name === "a.txt")?.path).toBe("/VfsCoreListMount/a.txt");

    const stat = await vfs.stat("/VfsCoreListMount/a.txt");
    expect(stat.type).toBe("file");
    expect(stat.path).toBe("/VfsCoreListMount/a.txt");
  } finally {
    cleanup();
  }
});

test("readBuffer()/writeBuffer() dispatch to a registered mount", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-mount-buffer");
  try {
    vfs.registerMount("/VfsCoreBufferMount", new LocalFS(join(dir, "backend")));
    const bytes = Buffer.from([1, 2, 3]);
    await vfs.writeBuffer("/VfsCoreBufferMount/blob.bin", bytes);
    expect(await vfs.readBuffer("/VfsCoreBufferMount/blob.bin")).toEqual(bytes);
  } finally {
    cleanup();
  }
});

test("mkdir()/remove() dispatch to a registered mount", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-mount-mkdir-remove");
  try {
    vfs.registerMount("/VfsCoreMkdirMount", new LocalFS(join(dir, "backend")));
    await vfs.mkdir("/VfsCoreMkdirMount/a/b");
    expect((await vfs.stat("/VfsCoreMkdirMount/a/b")).type).toBe("dir");

    await vfs.remove("/VfsCoreMkdirMount/a");
    await expect(vfs.stat("/VfsCoreMkdirMount/a")).rejects.toThrow();
  } finally {
    cleanup();
  }
});

test("rename() dispatches to a registered mount when both sides share the same backend", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-mount-rename");
  try {
    vfs.registerMount("/VfsCoreRenameMount", new LocalFS(join(dir, "backend")));
    await vfs.writeText("/VfsCoreRenameMount/from.txt", "content");
    await vfs.rename("/VfsCoreRenameMount/from.txt", "/VfsCoreRenameMount/to.txt");

    await expect(vfs.readText("/VfsCoreRenameMount/from.txt")).rejects.toThrow();
    expect(await vfs.readText("/VfsCoreRenameMount/to.txt")).toBe("content");
  } finally {
    cleanup();
  }
});

test("readStream()/writeStream() dispatch to a registered mount", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-mount-stream");
  try {
    vfs.registerMount("/VfsCoreStreamMount", new LocalFS(join(dir, "backend")));

    const { stream, done } = await vfs.writeStream("/VfsCoreStreamMount/f.txt");
    stream.end("streamed content");
    await done;

    const readable = await vfs.readStream("/VfsCoreStreamMount/f.txt");
    expect(await collectStream(readable)).toBe("streamed content");
  } finally {
    cleanup();
  }
});

// ---- rename() across a mount boundary is refused, never silently corrupted ----

test("rename() refuses to cross from one mount to a DIFFERENT mount", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-rename-cross-mount");
  try {
    vfs.registerMount("/VfsCoreRenameA", new LocalFS(join(dir, "a")));
    vfs.registerMount("/VfsCoreRenameB", new LocalFS(join(dir, "b")));
    await vfs.writeText("/VfsCoreRenameA/f.txt", "content");

    await expect(vfs.rename("/VfsCoreRenameA/f.txt", "/VfsCoreRenameB/f.txt")).rejects.toThrow(
      "Cannot rename across a VFS mount boundary",
    );
  } finally {
    cleanup();
  }
});

test("rename() refuses to cross from a mounted path to an unmounted one", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-rename-mount-to-plain");
  try {
    vfs.registerMount("/VfsCoreRenameC", new LocalFS(join(dir, "c")));
    await vfs.writeText("/VfsCoreRenameC/f.txt", "content");

    await expect(vfs.rename("/VfsCoreRenameC/f.txt", "/Documents/f.txt")).rejects.toThrow(
      "Cannot rename across a VFS mount boundary",
    );
  } finally {
    cleanup();
  }
});

// ---- Unmounted plain-path fallback (the ordinary /Documents,/Pictures,... tree) ----

test("stat()/readBuffer()/writeBuffer() on an unmounted plain path", async () => {
  const { cleanup } = useTestDataDir("vfs-core-plain-stat-buffer");
  try {
    const bytes = Buffer.from([9, 8, 7]);
    await vfs.writeBuffer("/Documents/blob.bin", bytes);
    expect(await vfs.readBuffer("/Documents/blob.bin")).toEqual(bytes);

    const stat = await vfs.stat("/Documents/blob.bin");
    expect(stat.type).toBe("file");
    expect(stat.name).toBe("blob.bin");
    expect(stat.path).toBe("/Documents/blob.bin");
  } finally {
    cleanup();
  }
});

test("mkdir()/remove()/rename() on unmounted plain paths", async () => {
  const { cleanup } = useTestDataDir("vfs-core-plain-mkdir-remove-rename");
  try {
    await vfs.mkdir("/Documents/newdir");
    expect((await vfs.stat("/Documents/newdir")).type).toBe("dir");

    await vfs.writeText("/Documents/newdir/f.txt", "content");
    await vfs.rename("/Documents/newdir/f.txt", "/Documents/newdir/g.txt");
    expect(await vfs.readText("/Documents/newdir/g.txt")).toBe("content");

    await vfs.remove("/Documents/newdir");
    await expect(vfs.stat("/Documents/newdir")).rejects.toThrow();
  } finally {
    cleanup();
  }
});

test("remove() refuses to delete the VFS root itself", async () => {
  const { cleanup } = useTestDataDir("vfs-core-remove-root");
  try {
    await expect(vfs.remove("/")).rejects.toThrow("Refusing to remove the VFS root");
  } finally {
    cleanup();
  }
});

test("readStream()/writeStream() round-trip an unmounted plain path via a real temp-file rename", async () => {
  const { cleanup } = useTestDataDir("vfs-core-plain-stream");
  try {
    const { stream, done } = await vfs.writeStream("/Documents/streamed.txt");
    stream.end("plain streamed content");
    await done;

    const readable = await vfs.readStream("/Documents/streamed.txt");
    expect(await collectStream(readable)).toBe("plain streamed content");
  } finally {
    cleanup();
  }
});

test("writeStream() on an unmounted path rejects done() and cleans up the temp file on a real write failure", async () => {
  if (process.getuid && process.getuid() === 0) return; // root bypasses permission bits — this needs a real EACCES
  const { dir, cleanup } = useTestDataDir("vfs-core-stream-error");
  try {
    const targetDir = join(dir, "vfs", "Documents", "readonly-dir");
    mkdirSync(targetDir, { recursive: true });
    chmodSync(targetDir, 0o555); // read + execute only — creating the temp file inside it must fail
    try {
      const { stream, done } = await vfs.writeStream("/Documents/readonly-dir/x.txt");
      stream.end("data");
      await expect(done).rejects.toThrow();
    } finally {
      chmodSync(targetDir, 0o755); // restore so cleanup() can rmSync recursively
    }
  } finally {
    cleanup();
  }
});

// ---- hostPath() ----

test("hostPath() resolves a VFS path to the real host path without touching the mount table or ensureVfs", async () => {
  const { dir, cleanup } = useTestDataDir("vfs-core-hostpath");
  try {
    const real = vfs.hostPath("/Documents/x.txt");
    expect(real).toBe(join(dir, "vfs", "Documents", "x.txt"));
  } finally {
    cleanup();
  }
});

// ---- resolveSafe()'s escape guard ----

test("a non-absolute BOS_DATA_DIR cannot resolve to a path 'under' itself — resolveSafe refuses rather than silently trusting it", () => {
  // hostPath() never calls ensureVfs(), so this is a pure, side-effect-free
  // way to exercise the defense-in-depth guard directly (relPath traversal
  // itself is already neutralized before this check ever sees it, same as
  // the equivalent guard in path-jail.ts).
  const previous = process.env.BOS_DATA_DIR;
  process.env.BOS_DATA_DIR = "relative-data-dir-should-never-happen";
  try {
    expect(() => vfs.hostPath("/Documents/x.txt")).toThrow("Path escapes the VFS root");
  } finally {
    if (previous === undefined) delete process.env.BOS_DATA_DIR;
    else process.env.BOS_DATA_DIR = previous;
  }
});

// ---- CANONICAL_SUBPATHS: Documents/Chats survives even when the two roots diverge ----

test("Documents/Chats resolves under BOS_CANONICAL_DATA while everything else resolves under BOS_DATA_DIR", async () => {
  const { dir: liveDir, cleanup: cleanupLive } = useTestDataDir("vfs-core-canonical-live");
  // A separate, plain temp dir (NOT another useTestDataDir() — that would
  // reset BOS_DATA_DIR too) so the two roots genuinely diverge, as they do
  // for real during a live-version-control preview: a per-version live root,
  // but one shared canonical root for chat history.
  const canonicalDir = mkdtempSync(join(tmpdir(), "vfs-core-canonical-root-"));
  process.env.BOS_CANONICAL_DATA = canonicalDir;
  try {
    await vfs.writeText("/Documents/Chats/convo.json", '{"ok":true}');
    await vfs.writeText("/Documents/note.txt", "plain");

    expect(await vfs.readText("/Documents/Chats/convo.json")).toBe('{"ok":true}');
    expect(await vfs.readText("/Documents/note.txt")).toBe("plain");

    // Prove it actually landed on two DIFFERENT disk locations, not just that
    // both read back through the same API.
    expect(vfs.hostPath("/Documents/note.txt")).toBe(join(liveDir, "vfs", "Documents", "note.txt"));
  } finally {
    rmSync(canonicalDir, { recursive: true, force: true });
    cleanupLive();
  }
});
