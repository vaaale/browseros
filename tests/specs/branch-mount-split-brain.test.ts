// Regression tests for a real production bug: two independent mechanisms both
// tried to `git worktree add` the SAME feature branch onto a spec store's repo
// — the Supervisor's own coupled-repo mount (the one dev/spec-fs.ts / Build
// Studio relies on exclusively) and os/fs/spec-fs.ts's (the agent's file_*
// tools) self-provisioning fallback, meant only for standalone dev with no
// Supervisor at all. Whichever won the race locked out the other permanently
// ("already used by worktree"), silently splitting a branch's spec content
// across two worktrees that no reader agreed on: Build Studio's dev/spec-fs.ts
// (no self-worktree awareness) silently fell back to the BASE checkout and
// reported "Could not load" for content that only ever existed on the
// self-provisioned side.
//
// Both call sites are fixed to fail loudly instead of silently resolving to
// the wrong root when a caller explicitly asked for a branch's content and
// that branch's mount isn't there — see os/fs/spec-fs.ts's writeRoot/readRoot
// and dev/spec-fs.ts's resolveInStore.
//   npm run test:unit -- tests/specs/branch-mount-split-brain.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { promises as fs } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { ensureStores } from "../../src/lib/specs/seed";
import { ensureRepo } from "../../src/lib/gitfs/store";
import { ensureWorktree } from "../../src/os/fs/git-fs";
import { encodeBranchDir } from "../../src/lib/specs/feature-id";
import { SpecFS } from "../../src/os/fs/spec-fs";
import { withFeatureScope } from "../../src/lib/specs/feature-context";
import * as specfs from "../../src/lib/dev/spec-fs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Stub global.fetch so supervisorEnabled()/supervisorBegin() (real HTTP
 *  clients) believe a Supervisor is running at BOS_SUPERVISOR_URL and always
 *  hand back `worktree`, without a real Supervisor process. */
function stubSupervisor(worktree: string): () => void {
  process.env.BOS_SUPERVISOR_URL = "http://fake-supervisor.invalid";
  const realFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/__supervisor/begin")) {
      return new Response(JSON.stringify({ ok: true, branch: "x", worktree }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    delete process.env.BOS_SUPERVISOR_URL;
    global.fetch = realFetch;
  };
}

test("os/fs/spec-fs.ts: writeRoot throws instead of self-provisioning a competing worktree when the Supervisor is up but hasn't mounted this store yet", async () => {
  const { dir, cleanup } = useTestDataDir("split-brain-write-no-mount");
  try {
    const repoRoot = join(dir, "specs", "user-specs");
    const worktreesBase = join(dir, "specs", ".worktrees");
    await ensureRepo(repoRoot);
    const branch = "bos/split-brain-a";

    // Supervisor is "up" and returns a real worktree dir, but it has NO
    // specs/user-specs subdirectory at all (the coupled mount never
    // succeeded for this store) — the exact state found live.
    const fakeCodeWorktree = join(dir, "fake-code-worktree");
    await fs.mkdir(join(fakeCodeWorktree, "specs"), { recursive: true });
    const restore = stubSupervisor(fakeCodeWorktree);

    try {
      const specFs = new SpecFS(repoRoot, "user-specs", worktreesBase, true);
      await expect(
        withFeatureScope({ branch }, () => specFs.writeText("foo/bar.md", "hello")),
      ).rejects.toThrow(/not mounted/i);

      // The critical regression check: no competing self-provisioned worktree
      // was created as a silent fallback.
      const selfWt = join(worktreesBase, encodeBranchDir(branch));
      await expect(fs.access(selfWt)).rejects.toThrow();
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

test("os/fs/spec-fs.ts: a pre-existing self-provisioned worktree is cleared (not left to permanently block the Supervisor's mount)", async () => {
  const { dir, cleanup } = useTestDataDir("split-brain-handoff");
  try {
    const repoRoot = join(dir, "specs", "user-specs");
    const worktreesBase = join(dir, "specs", ".worktrees");
    await ensureRepo(repoRoot);
    const branch = "bos/split-brain-b";

    // Simulate the corrupted state found live: a self-provisioned worktree
    // already has this branch checked out, fully committed.
    const selfWt = join(worktreesBase, encodeBranchDir(branch));
    await ensureWorktree(repoRoot, selfWt, branch);
    await fs.writeFile(join(selfWt, "existing.md"), "already here");
    git(selfWt, ["add", "-A"]);
    git(selfWt, ["commit", "-q", "-m", "pre-existing self-provisioned commit"]);

    const fakeCodeWorktree = join(dir, "fake-code-worktree");
    await fs.mkdir(join(fakeCodeWorktree, "specs"), { recursive: true });
    const restore = stubSupervisor(fakeCodeWorktree);
    try {
      const specFs = new SpecFS(repoRoot, "user-specs", worktreesBase, true);
      // The Supervisor still hasn't mounted this store (fake worktree has no
      // specs/user-specs dir), so the write still fails — but the self
      // worktree must be gone either way, so a LATER retry (once the real
      // Supervisor mount succeeds) isn't permanently blocked by it.
      await expect(withFeatureScope({ branch }, () => specFs.writeText("foo.md", "x"))).rejects.toThrow();
      await expect(fs.access(selfWt)).rejects.toThrow();
      // The branch's commit history survives the worktree being cleared —
      // reachable from the shared repo regardless of which worktree checks it
      // out next.
      expect(git(repoRoot, ["log", "--oneline", branch])).toContain("pre-existing self-provisioned commit");
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

test("os/fs/spec-fs.ts: writeText succeeds against a properly mounted Supervisor worktree", async () => {
  const { dir, cleanup } = useTestDataDir("split-brain-happy-path");
  try {
    const repoRoot = join(dir, "specs", "user-specs");
    const worktreesBase = join(dir, "specs", ".worktrees");
    await ensureRepo(repoRoot);
    const branch = "bos/split-brain-c";

    // A properly mounted Supervisor worktree: specs/user-specs is a real
    // worktree of the same repo, checked out on `branch`.
    const fakeCodeWorktree = join(dir, "fake-code-worktree");
    const mountedStore = join(fakeCodeWorktree, "specs", "user-specs");
    await ensureWorktree(repoRoot, mountedStore, branch);
    const restore = stubSupervisor(fakeCodeWorktree);
    try {
      const specFs = new SpecFS(repoRoot, "user-specs", worktreesBase, true);
      await withFeatureScope({ branch }, () => specFs.writeText("foo.md", "hello world"));
      const written = await fs.readFile(join(mountedStore, "foo.md"), "utf8");
      expect(written).toBe("hello world");
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});

test("dev/spec-fs.ts (Build Studio's own path): a write with an explicit branch throws rather than silently landing on the store's base checkout when that store's mount is missing", async () => {
  const { dir, cleanup } = useTestDataDir("split-brain-dev-spec-fs");
  try {
    await ensureStores();
    const branch = "bos/split-brain-d";

    // A Supervisor worktree where a DIFFERENT store mounted fine (so
    // `specs/` itself exists) but user-specs specifically never did — the
    // exact live-production shape (bos-system-specs mounted, user-specs
    // didn't).
    const fakeCodeWorktree = join(dir, "fake-code-worktree");
    await fs.mkdir(join(fakeCodeWorktree, "specs", "bos-system-specs"), { recursive: true });
    const restore = stubSupervisor(fakeCodeWorktree);
    try {
      await expect(specfs.writeFile("user-specs/some-project/001-feature/spec.md", "content", { branch })).rejects.toThrow(
        /not mounted/i,
      );
      // The write must NOT have landed on the store's base checkout either.
      const baseContent = await fs
        .readFile(join(dir, "specs", "user-specs", "some-project", "001-feature", "spec.md"), "utf8")
        .catch(() => null);
      expect(baseContent).toBeNull();
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
});
