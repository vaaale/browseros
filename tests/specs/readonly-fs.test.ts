// Unit tests for ReadonlyFS (027-vfs-specfs): reads pass straight through to
// LocalFS, every write op refuses. Used for /Templates so agents can read
// BOS-owned reference material but never write it.
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { ReadonlyFS } from "../../src/os/fs/readonly-fs";

function makeFixture(dir: string): string {
  const root = join(dir, "templates");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.md"), "# A\n");
  writeFileSync(join(root, "sub", "b.md"), "# B\n");
  return root;
}

test("reads (list/stat/readText/readBuffer/exists) pass straight through", async () => {
  const { dir, cleanup } = useTestDataDir("readonly-fs-reads");
  try {
    const root = makeFixture(dir);
    const fs = new ReadonlyFS(root);

    const entries = await fs.list("");
    expect(entries.map((e) => e.name).sort()).toEqual(["a.md", "sub"]);

    const stat = await fs.stat("a.md");
    expect(stat.type).toBe("file");

    expect(await fs.readText("a.md")).toBe("# A\n");
    expect((await fs.readBuffer("sub/b.md")).toString("utf8")).toBe("# B\n");
    expect(await fs.exists("a.md")).toBe(true);
    expect(await fs.exists("missing.md")).toBe(false);
  } finally {
    cleanup();
  }
});

test("every write method refuses — read-only means read-only", async () => {
  const { dir, cleanup } = useTestDataDir("readonly-fs-writes");
  try {
    const root = makeFixture(dir);
    const fs = new ReadonlyFS(root);

    await expect(fs.writeText("a.md", "hacked")).rejects.toThrow("This filesystem is read-only");
    await expect(fs.writeBuffer("a.md", Buffer.from("hacked"))).rejects.toThrow("This filesystem is read-only");
    await expect(fs.mkdir("new-dir")).rejects.toThrow("This filesystem is read-only");
    await expect(fs.remove("a.md")).rejects.toThrow("This filesystem is read-only");
    await expect(fs.rename("a.md", "z.md")).rejects.toThrow("This filesystem is read-only");
  } finally {
    cleanup();
  }
});
