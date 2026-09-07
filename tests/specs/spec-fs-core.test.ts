// Unit tests for SpecFS (src/os/fs/spec-fs.ts), the FSBackend mounted at
// /Specs/<store-id>. tests/specs/branch-mount-split-brain.test.ts already
// covers the Supervisor/self-worktree split-brain hand-off in depth; this
// file covers what that one doesn't: the read side entirely (list/stat/
// readText/readBuffer/exists, manifest filtering, every root-resolution
// branch), the standalone-dev (no Supervisor) write path, the two error
// classes, the commit-message DI hook, flushPending(), and the startup
// crash-recovery sweep.
//   npm run test:unit -- tests/specs/spec-fs-core.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { SpecFS, SpecFSNoContextError, SpecFSReadOnlyError } from "../../src/os/fs/spec-fs";
import { withFeatureScope } from "../../src/lib/specs/feature-context";
import { ensureRepo } from "../../src/lib/gitfs/store";
import { ensureWorktree } from "../../src/os/fs/git-fs";
import { STORE_MANIFEST, PROJECT_MANIFEST } from "../../src/lib/specs/stores";

// Real git repos MUST live outside browseros' own working tree — see
// tests/specs/git-fs.test.ts for why (git walks up to the enclosing .git).
function scratchDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sysGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Stub global.fetch so supervisorEnabled()/supervisorBeginOrThrow() believe a
 *  Supervisor is running, without a real Supervisor process. Mirrors
 *  tests/specs/branch-mount-split-brain.test.ts. */
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

// ---- Error classes ----

test("writes to a non-writable store always throw SpecFSReadOnlyError, branch or not", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-readonly");
  try {
    const fs = new SpecFS(join(dir, "repo"), "bos-system-specs", join(dir, ".worktrees"), false);
    await expect(fs.writeText("a.md", "x")).rejects.toThrow(SpecFSReadOnlyError);
    await expect(
      withFeatureScope({ branch: "bos/x" }, () => fs.writeText("a.md", "x")),
    ).rejects.toThrow(SpecFSReadOnlyError);
  } finally {
    cleanup();
  }
});

test("writes to a writable store with no active feature context throw SpecFSNoContextError", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-no-context");
  try {
    const fs = new SpecFS(join(dir, "repo"), "user-specs", join(dir, ".worktrees"), true);
    await expect(fs.writeText("a.md", "x")).rejects.toThrow(SpecFSNoContextError);
  } finally {
    cleanup();
  }
});

// ---- Standalone dev (no Supervisor): self-provisioned worktree read/write ----

test("standalone dev: writes self-provision a worktree, reads see them, flushPending commits", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-standalone");
  try {
    const repoRoot = join(dir, "repo");
    const worktreesBase = join(dir, ".worktrees");
    const fs = new SpecFS(repoRoot, "user-specs", worktreesBase, true);

    await withFeatureScope({ branch: "bos/feature" }, async () => {
      await fs.writeText("page.md", "content");
      await fs.mkdir("sub");
      await fs.writeBuffer("blob.bin", Buffer.from([1, 2, 3]));
      // Manifests and dotfiles are hidden from the listing.
      await fs.writeText(STORE_MANIFEST, "{}");
      await fs.writeText(PROJECT_MANIFEST, "{}");

      const names = (await fs.list("")).map((e) => e.name).sort();
      expect(names).toEqual(["blob.bin", "page.md", "sub"]);

      expect(await fs.exists("page.md")).toBe(true);
      expect(await fs.readText("page.md")).toBe("content");
      expect(await fs.readBuffer("blob.bin")).toEqual(Buffer.from([1, 2, 3]));
      expect((await fs.stat("page.md")).type).toBe("file");

      await fs.rename("page.md", "renamed.md");
      expect(await fs.exists("page.md")).toBe(false);
      expect(await fs.exists("renamed.md")).toBe(true);

      await fs.remove("renamed.md");
      expect(await fs.exists("renamed.md")).toBe(false);

      await fs.flushPending("bos/feature");
    });

    const worktreePath = join(worktreesBase, "bos__feature");
    expect(sysGit(worktreePath, ["log", "-1", "--format=%s"])).toBeTruthy();
    expect(sysGit(worktreePath, ["status", "--porcelain"])).toBe("");
  } finally {
    cleanup();
  }
});

test("flushPending() is a no-op when the branch was never written", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-flush-noop");
  try {
    const fs = new SpecFS(join(dir, "repo"), "user-specs", join(dir, ".worktrees"), true);
    await expect(fs.flushPending("bos/never-touched")).resolves.toBeUndefined();
  } finally {
    cleanup();
  }
});

// ---- readRoot()'s fallback ladder without a Supervisor ----

test("readRoot(): no active branch reads the base checkout directly", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-read-no-branch");
  try {
    const repoRoot = join(dir, "repo");
    await ensureRepo(repoRoot);
    writeFileSync(join(repoRoot, "base.md"), "base content");
    sysGit(repoRoot, ["add", "-A"]);
    sysGit(repoRoot, ["commit", "--quiet", "-m", "seed"]);

    const fs = new SpecFS(repoRoot, "user-specs", join(dir, ".worktrees"), true);
    expect(await fs.readText("base.md")).toBe("base content");
  } finally {
    cleanup();
  }
});

test("readRoot(): an active branch that was never materialized falls back to the base checkout", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-read-unmaterialized");
  try {
    const repoRoot = join(dir, "repo");
    await ensureRepo(repoRoot);
    writeFileSync(join(repoRoot, "base.md"), "base content");
    sysGit(repoRoot, ["add", "-A"]);
    sysGit(repoRoot, ["commit", "--quiet", "-m", "seed"]);

    const fs = new SpecFS(repoRoot, "user-specs", join(dir, ".worktrees"), true);
    await withFeatureScope({ branch: "bos/never-written" }, async () => {
      expect(await fs.readText("base.md")).toBe("base content");
    });
  } finally {
    cleanup();
  }
});

// ---- Supervisor-stubbed reads/writes ----

test("readRoot(): resolves through the Supervisor's mounted worktree when one exists", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-read-supervisor");
  try {
    const worktree = join(dir, "fake-worktree");
    mkdirSync(join(worktree, "specs", "user-specs"), { recursive: true });
    writeFileSync(join(worktree, "specs", "user-specs", "branch-only.md"), "branch content");
    const restore = stubSupervisor(worktree);
    try {
      const fs = new SpecFS(join(dir, "repo"), "user-specs", join(dir, ".worktrees"), true);
      await withFeatureScope({ branch: "bos/feature" }, async () => {
        expect(await fs.readText("branch-only.md")).toBe("branch content");
      });
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

test("readRoot(): falls back to the base checkout when the Supervisor's begin call fails", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-read-supervisor-fail");
  try {
    const repoRoot = join(dir, "repo");
    await ensureRepo(repoRoot);
    writeFileSync(join(repoRoot, "base.md"), "base content");
    sysGit(repoRoot, ["add", "-A"]);
    sysGit(repoRoot, ["commit", "--quiet", "-m", "seed"]);

    const restore = stubSupervisor("/unused", { fail: true });
    try {
      const fs = new SpecFS(repoRoot, "user-specs", join(dir, ".worktrees"), true);
      await withFeatureScope({ branch: "bos/feature" }, async () => {
        expect(await fs.readText("base.md")).toBe("base content");
      });
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

test("writeRoot(): under the Supervisor, writes land in its mounted worktree", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-write-supervisor");
  try {
    const worktree = join(dir, "fake-worktree");
    mkdirSync(join(worktree, "specs", "user-specs"), { recursive: true });
    const restore = stubSupervisor(worktree);
    try {
      const fs = new SpecFS(join(dir, "repo"), "user-specs", join(dir, ".worktrees"), true);
      await withFeatureScope({ branch: "bos/feature" }, async () => {
        await fs.writeText("page.md", "content");
      });
      const written = join(worktree, "specs", "user-specs", "page.md");
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, "utf8")).toBe("content");
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

test("writeRoot(): under the Supervisor, throws with the mount-error cause when the store isn't mounted yet", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-write-not-mounted");
  try {
    // No specs/user-specs dir under the fake worktree — SpecFS.dirExists fails.
    const worktree = join(dir, "fake-worktree");
    mkdirSync(worktree, { recursive: true });
    const restore = stubSupervisor(worktree);
    try {
      const fs = new SpecFS(join(dir, "repo"), "user-specs", join(dir, ".worktrees"), true);
      await withFeatureScope({ branch: "bos/feature" }, async () => {
        await expect(fs.writeText("page.md", "content")).rejects.toThrow(/not mounted on branch/);
      });
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

// ---- Commit-message DI hook (setCommitMessageFn / buildCommitMessage) ----

test("setCommitMessageFn(): a successful custom message is used verbatim (trimmed)", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-commit-msg-custom");
  try {
    const fs = new SpecFS(join(dir, "repo"), "user-specs", join(dir, ".worktrees"), true);
    fs.setCommitMessageFn(async () => "  custom message  ");
    await withFeatureScope({ branch: "bos/feature" }, async () => {
      await fs.writeText("page.md", "content");
      await fs.flushPending("bos/feature");
    });
    const worktreePath = join(dir, ".worktrees", "bos__feature");
    expect(sysGit(worktreePath, ["log", "-1", "--format=%s"])).toBe("custom message");
  } finally {
    cleanup();
  }
});

test("setCommitMessageFn(): an empty or throwing custom message falls back to the deterministic one", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-commit-msg-fallback");
  try {
    const fsEmpty = new SpecFS(join(dir, "repo-empty"), "user-specs", join(dir, ".worktrees-empty"), true);
    fsEmpty.setCommitMessageFn(async () => "   ");
    await withFeatureScope({ branch: "bos/feature" }, async () => {
      await fsEmpty.writeText("page.md", "content");
      await fsEmpty.flushPending("bos/feature");
    });
    const emptyMsg = sysGit(join(dir, ".worktrees-empty", "bos__feature"), ["log", "-1", "--format=%s"]);
    expect(emptyMsg).not.toBe("");
    expect(emptyMsg).not.toBe("   ");

    const fsThrow = new SpecFS(join(dir, "repo-throw"), "user-specs", join(dir, ".worktrees-throw"), true);
    fsThrow.setCommitMessageFn(async () => {
      throw new Error("model unavailable");
    });
    await withFeatureScope({ branch: "bos/feature" }, async () => {
      await fsThrow.writeText("page.md", "content");
      await fsThrow.flushPending("bos/feature");
    });
    const throwMsg = sysGit(join(dir, ".worktrees-throw", "bos__feature"), ["log", "-1", "--format=%s"]);
    expect(throwMsg).toBeTruthy();
  } finally {
    cleanup();
  }
});

// ---- Startup crash-recovery sweep ----

test("runStartupSweep(): no-ops when nothing is uncommitted, and only runs once", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-sweep-noop");
  try {
    const repoRoot = join(dir, "repo");
    const fs = new SpecFS(repoRoot, "user-specs", join(dir, ".worktrees"), true);
    await fs.runStartupSweep();
    await fs.runStartupSweep(); // second call must be a true no-op (sweptOnce)
    expect(sysGit(repoRoot, ["log", "-1", "--format=%s"])).toBe("init content repo");
  } finally {
    cleanup();
  }
});

test("runStartupSweep(): recovers uncommitted edits left on the base checkout and any worktree", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-sweep-recover");
  try {
    const repoRoot = join(dir, "repo");
    await ensureRepo(repoRoot);
    // Simulate a crash before the debounced commit: an uncommitted edit
    // sitting directly on disk, never routed through SpecFS.writeText.
    writeFileSync(join(repoRoot, "uncommitted.md"), "orphaned edit");

    const worktreePath = join(dir, "wt");
    await ensureWorktree(repoRoot, worktreePath, "bos/orphan");
    writeFileSync(join(worktreePath, "also-orphaned.md"), "orphaned edit 2");

    const fs = new SpecFS(repoRoot, "user-specs", join(dir, ".worktrees"), true);
    await fs.runStartupSweep();

    expect(sysGit(repoRoot, ["status", "--porcelain"])).toBe("");
    expect(sysGit(repoRoot, ["log", "-1", "--format=%s"])).toContain("recover uncommitted spec edits");
    expect(sysGit(worktreePath, ["status", "--porcelain"])).toBe("");
    expect(sysGit(worktreePath, ["log", "-1", "--format=%s"])).toContain("recover uncommitted spec edits");
  } finally {
    cleanup();
  }
});

test("runStartupSweep(): swallows a failure (e.g. an unusable repo root) instead of throwing", async () => {
  const { dir, cleanup } = scratchDir("spec-fs-sweep-failure");
  try {
    // A plain FILE where SpecFS expects to mkdir a repo directory — ensureRepo's
    // `fs.mkdir(root, {recursive:true})` must fail with ENOTDIR.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const repoRoot = join(blocker, "repo");

    const fs = new SpecFS(repoRoot, "user-specs", join(dir, ".worktrees"), true);
    await expect(fs.runStartupSweep()).resolves.toBeUndefined();
  } finally {
    cleanup();
  }
});
