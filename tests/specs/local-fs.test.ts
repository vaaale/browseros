// Unit tests for LocalFS (027-vfs-specfs), the default FSBackend that SpecFS/
// DocsFS/ReadonlyFS compose. Only exercised indirectly elsewhere (through
// those backends); this covers it directly, including the buffer/mkdir/
// remove/rename surface that has no other test coverage.
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { LocalFS } from "../../src/os/fs/local-fs";

test("readBuffer/writeBuffer round-trip binary data", async () => {
  const { dir, cleanup } = useTestDataDir("local-fs-buffer");
  try {
    const fs = new LocalFS(dir);
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    await fs.writeBuffer("blob.bin", bytes);
    expect(await fs.readBuffer("blob.bin")).toEqual(bytes);
  } finally {
    cleanup();
  }
});

test("stat('') names the root itself '/'", async () => {
  const { dir, cleanup } = useTestDataDir("local-fs-stat-root");
  try {
    const fs = new LocalFS(dir);
    const stat = await fs.stat("");
    expect(stat.name).toBe("/");
    expect(stat.path).toBe("/");
    expect(stat.type).toBe("dir");
  } finally {
    cleanup();
  }
});

test("mkdir creates nested directories, list()/stat() see the result", async () => {
  const { dir, cleanup } = useTestDataDir("local-fs-mkdir");
  try {
    const fs = new LocalFS(dir);
    await fs.mkdir("a/b/c");
    expect((await fs.stat("a/b/c")).type).toBe("dir");
    expect((await fs.list("a/b")).map((e) => e.name)).toEqual(["c"]);
  } finally {
    cleanup();
  }
});

test("remove deletes a file or directory recursively", async () => {
  const { dir, cleanup } = useTestDataDir("local-fs-remove");
  try {
    const fs = new LocalFS(dir);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f.txt"), "x");

    await fs.remove("sub");
    expect(existsSync(join(dir, "sub"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("remove refuses to delete the filesystem root itself", async () => {
  const { dir, cleanup } = useTestDataDir("local-fs-remove-root");
  try {
    const fs = new LocalFS(dir);
    await expect(fs.remove("")).rejects.toThrow("Refusing to remove the filesystem root");
    expect(existsSync(dir)).toBe(true);
  } finally {
    cleanup();
  }
});

test("rename moves a file, creating the destination's parent directory", async () => {
  const { dir, cleanup } = useTestDataDir("local-fs-rename");
  try {
    const fs = new LocalFS(dir);
    await fs.writeText("from.txt", "content");
    await fs.rename("from.txt", "new-dir/to.txt");

    expect(await fs.exists("from.txt")).toBe(false);
    expect(await fs.readText("new-dir/to.txt")).toBe("content");
  } finally {
    cleanup();
  }
});
