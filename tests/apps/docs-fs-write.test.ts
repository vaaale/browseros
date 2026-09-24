// Unit tests for DocsFS's write path and Supervisor-backed read path
// (src/os/fs/docs-fs.ts). docs-fs-overlay.test.ts covers the item-docs
// overlay on reads; this file covers what that one deliberately didn't touch:
// writes require an active feature branch, a branch's own worktree is where
// reads/writes actually land under the Supervisor, and the not-found paths
// for readText/readBuffer/exists.
//   npm run test:unit -- tests/apps/docs-fs-write.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { DocsFS } from "../../src/os/fs/docs-fs";
import { withFeatureScope } from "../../src/lib/specs/feature-context";

/** Stub global.fetch so supervisorEnabled()/supervisorBeginOrThrow() (real HTTP
 *  clients) believe a Supervisor is running at BOS_SUPERVISOR_URL, without a
 *  real Supervisor process. Mirrors tests/specs/branch-mount-split-brain.test.ts. */
function stubSupervisor(worktree: string, opts?: { fail?: boolean }): () => void {
  process.env.BOS_SUPERVISOR_URL = "http://fake-supervisor.invalid";
  const realFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/__supervisor/begin")) {
      if (opts?.fail) return new Response(JSON.stringify({ ok: false, error: "begin failed (test)" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, branch: "x", worktree }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    delete process.env.BOS_SUPERVISOR_URL;
    global.fetch = realFetch;
  };
}

test("every write method refuses without an active feature branch — none touch disk", async () => {
  const { cleanup } = useTestDataDir("docs-fs-write-no-branch");
  try {
    const docsFs = new DocsFS();
    const msg = "No active feature branch — call dev_branch_request before editing docs/.";
    await expect(docsFs.writeText("usage/x.md", "content")).rejects.toThrow(msg);
    await expect(docsFs.writeBuffer("usage/x.md", Buffer.from("content"))).rejects.toThrow(msg);
    await expect(docsFs.mkdir("usage/new-dir")).rejects.toThrow(msg);
    await expect(docsFs.remove("usage/x.md")).rejects.toThrow(msg);
    await expect(docsFs.rename("usage/x.md", "usage/y.md")).rejects.toThrow(msg);
  } finally {
    cleanup();
  }
});

test("writes land in the active branch's Supervisor-mounted worktree, not the canonical checkout", async () => {
  const { dir, cleanup } = useTestDataDir("docs-fs-write-worktree");
  try {
    const worktree = join(dir, "fake-worktree");
    mkdirSync(join(worktree, "docs", "usage"), { recursive: true });
    const restoreSupervisor = stubSupervisor(worktree);
    try {
      const docsFs = new DocsFS();
      await withFeatureScope({ branch: "bos/testfixture-docs-test" }, async () => {
        await docsFs.mkdir("usage/NewSection");
        await docsFs.writeText("usage/NewSection/page.md", "# Hi\n");
        await docsFs.writeBuffer("usage/NewSection/blob.bin", Buffer.from([1, 2, 3]));

        expect(await docsFs.readText("usage/NewSection/page.md")).toBe("# Hi\n");
        expect(existsSync(join(worktree, "docs", "usage", "NewSection", "page.md"))).toBe(true);
        expect(existsSync(join(worktree, "docs", "usage", "NewSection", "blob.bin"))).toBe(true);

        await docsFs.rename("usage/NewSection/page.md", "usage/NewSection/renamed.md");
        expect(existsSync(join(worktree, "docs", "usage", "NewSection", "page.md"))).toBe(false);
        expect(existsSync(join(worktree, "docs", "usage", "NewSection", "renamed.md"))).toBe(true);

        await docsFs.remove("usage/NewSection");
        expect(existsSync(join(worktree, "docs", "usage", "NewSection"))).toBe(false);
      });
    } finally {
      restoreSupervisor();
    }
  } finally {
    cleanup();
  }
});

test("reads resolve through the active branch's Supervisor worktree when one is mounted", async () => {
  const { dir, cleanup } = useTestDataDir("docs-fs-read-worktree");
  try {
    const worktree = join(dir, "fake-worktree");
    mkdirSync(join(worktree, "docs", "usage"), { recursive: true });
    writeFileSync(join(worktree, "docs", "usage", "branch-only.md"), "# Branch-only page\n");
    const restoreSupervisor = stubSupervisor(worktree);
    try {
      const docsFs = new DocsFS();
      await withFeatureScope({ branch: "bos/testfixture-docs-test" }, async () => {
        expect(await docsFs.readText("usage/branch-only.md")).toContain("Branch-only page");
      });
    } finally {
      restoreSupervisor();
    }
  } finally {
    cleanup();
  }
});

test("reads fall back to the canonical checkout when the Supervisor's begin call fails", async () => {
  const { cleanup } = useTestDataDir("docs-fs-read-supervisor-failure");
  try {
    const restoreSupervisor = stubSupervisor("/unused", { fail: true });
    try {
      const docsFs = new DocsFS();
      await withFeatureScope({ branch: "bos/testfixture-docs-test" }, async () => {
        // introduction.md is a real page in this repo's own docs/usage/ — the
        // fallback resolves to CANONICAL_DOCS_ROOT, so this is safe to read.
        expect(await docsFs.exists("usage/introduction.md")).toBe(true);
      });
    } finally {
      restoreSupervisor();
    }
  } finally {
    cleanup();
  }
});

test("stat/readText/readBuffer/exists report a missing page as not-found rather than throwing an unrelated error", async () => {
  const { cleanup } = useTestDataDir("docs-fs-not-found");
  try {
    const docsFs = new DocsFS();
    await expect(docsFs.stat("usage/does-not-exist-xyz.md")).rejects.toThrow("ENOENT");
    await expect(docsFs.readText("usage/does-not-exist-xyz.md")).rejects.toThrow("ENOENT");
    await expect(docsFs.readBuffer("usage/does-not-exist-xyz.md")).rejects.toThrow("ENOENT");
    expect(await docsFs.exists("usage/does-not-exist-xyz.md")).toBe(false);
  } finally {
    cleanup();
  }
});

test("readBuffer reads an existing page's bytes", async () => {
  const { cleanup } = useTestDataDir("docs-fs-readbuffer");
  try {
    const docsFs = new DocsFS();
    // introduction.md is a real page in this repo's own docs/usage/.
    const buf = await docsFs.readBuffer("usage/introduction.md");
    expect(buf.length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});
