// Unit tests for file-history browsing + restore (037-project-layer, Phase
// 6): gitfs/store.ts's history() cross-branch support, store-git.ts's
// readFileAtRef (any commit, not just bos/* draft branches), and the
// /api/specs/history route (list, content-at-ref, restore).
//   npm run test:unit -- tests/specs/history.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { NextRequest } from "next/server";
import { useTestDataDir } from "../services/_test-env";
import { ensureStores } from "../../src/lib/specs/seed";
import { listCatalog } from "../../src/lib/marketplace/client";
import { createProject } from "../../src/lib/specs/projects";
import { history } from "../../src/lib/gitfs/store";
import { readFileAtRef } from "../../src/lib/specs/store-git";
import * as specfs from "../../src/lib/dev/spec-fs";
import { GET, POST } from "../../src/app/api/specs/history/route";
import { gitLogger } from "../../src/lib/gitops/logging";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

function storeRoot(): string {
  return join(process.env.BOS_DATA_DIR ?? "", "specs", "user-specs");
}

/** Write a file directly (bypassing specfs, which needs a live Supervisor to
 *  actually mount a branch's worktree — not available in a unit test) and
 *  commit it straight to the store's current checkout. Good enough for
 *  seeding history fixtures; the routes under test only need real commits to
 *  read back, not a live branch/worktree. */
function commitDirect(root: string, rel: string, content: string, message: string): void {
  mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(root, rel), content);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

/** A real branch + worktree with its own commit, isolated from the store's
 *  default branch — created directly via git (not specfs/a feature branch
 *  session, retired), just to exercise history()'s cross-branch reach. */
function seedBranch(root: string, branch: string, rel: string, content: string, message: string): string {
  const worktreePath = `${root}-${branch.replace(/\//g, "__")}-worktree`;
  git(root, ["worktree", "add", worktreePath, "-b", branch]);
  commitDirect(worktreePath, rel, content, message);
  return worktreePath;
}

test("history() lists every commit that touched a path; readFileAtRef reads any of them by sha", async () => {
  const { cleanup } = useTestDataDir("history-basic");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha");
    const root = storeRoot();
    commitDirect(root, "alpha/001-foo/spec.md", "# Foo v1\n", "v1");
    commitDirect(root, "alpha/001-foo/spec.md", "# Foo v2\n", "v2");

    const entries = await history(root, "alpha/001-foo/spec.md", 50, { all: true });
    expect(entries.length).toBe(2);

    // Newest first (git log default order).
    const [latest, oldest] = entries;
    expect(await readFileAtRef(root, latest.hash, "alpha/001-foo/spec.md")).toContain("v2");
    expect(await readFileAtRef(root, oldest.hash, "alpha/001-foo/spec.md")).toContain("v1");
  } finally {
    await gitLogger().flush();
    cleanup();
  }
});

test("history({all:true}) spans any branch in the repo, not just the current checkout", async () => {
  const { cleanup } = useTestDataDir("history-cross-branch");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha");
    const root = storeRoot();

    // This commit exists ONLY on "alpha/work" — the store's own default
    // branch (master) never merged it.
    seedBranch(root, "alpha/work", "alpha/001-foo/spec.md", "# Foo on a branch\n", "on a branch");

    const withAll = await history(root, "alpha/001-foo/spec.md", 50, { all: true });
    expect(withAll.length).toBe(1);

    const withoutAll = await history(root, "alpha/001-foo/spec.md", 50);
    expect(withoutAll.length).toBe(0); // current checkout (master) has no such commit in its own history
  } finally {
    await gitLogger().flush();
    cleanup();
  }
});

test("GET lists history and reads content at a ref through the route", async () => {
  const { cleanup } = useTestDataDir("history-route-get");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha");
    commitDirect(storeRoot(), "alpha/001-foo/spec.md", "# Foo v1\n", "v1");

    const listRes = await GET(new NextRequest(`http://local/api/specs/history?path=${encodeURIComponent("user-specs/alpha/001-foo/spec.md")}`));
    const listBody = await listRes.json();
    expect(listBody.history).toHaveLength(1);
    const sha = listBody.history[0].hash;

    const contentRes = await GET(
      new NextRequest(`http://local/api/specs/history?path=${encodeURIComponent("user-specs/alpha/001-foo/spec.md")}&ref=${sha}`),
    );
    expect((await contentRes.json()).content).toContain("v1");
  } finally {
    await gitLogger().flush();
    cleanup();
  }
});

test("POST restores a historical version as a NEW commit, gated by the active-feature-branch rule", async () => {
  const { cleanup } = useTestDataDir("history-route-restore");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha");
    const root = storeRoot();
    commitDirect(root, "alpha/001-foo/spec.md", "# Foo v1\n", "v1");
    const [v1] = await history(root, "alpha/001-foo/spec.md", 50, { all: true });
    commitDirect(root, "alpha/001-foo/spec.md", "# Foo v2\n", "v2");

    const restoreRes = await POST(
      new NextRequest("http://local/api/specs/history", {
        method: "POST",
        body: JSON.stringify({ path: "user-specs/alpha/001-foo/spec.md", ref: v1.hash, branch: "alpha/work" }),
      }),
    );
    expect(restoreRes.status).toBe(200);
    expect(await specfs.readFile("user-specs/alpha/001-foo/spec.md")).toContain("v1");

    // Restore created a NEW commit rather than rewriting history — 3 total now.
    const afterRestore = await history(root, "alpha/001-foo/spec.md", 50, { all: true });
    expect(afterRestore.length).toBe(3);
  } finally {
    await gitLogger().flush();
    cleanup();
  }
});

test("POST restore is refused with no feature branch given, same as any other write", async () => {
  const { cleanup } = useTestDataDir("history-route-restore-gated");
  try {
    await ensureStores();
    await createProject("user-specs", "Alpha");
    const root = storeRoot();
    commitDirect(root, "alpha/001-foo/spec.md", "# Foo on base\n", "seed on base");

    const res = await POST(
      new NextRequest("http://local/api/specs/history", {
        method: "POST",
        body: JSON.stringify({ path: "user-specs/alpha/001-foo/spec.md", ref: "HEAD" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("feature branch");
  } finally {
    await gitLogger().flush();
    cleanup();
  }
});

// --- item-owned stores ----------------------------------------------------
// An item store's root is `user-apps/items/<id>/spec`, a SUBDIRECTORY of the
// shared user-apps repo rather than a repo root of its own. Both git surfaces
// here used to be handed that root and silently produced nothing: history()
// bailed because there is no `.git` at the store root, and `git show
// <ref>:<path>` resolves its path against the REPO root, so the store-relative
// path did not exist there. The visible symptom was "View history" on an
// item's spec showing an empty list forever, with no error. Everything now
// goes through store.repoRoot + storeRepoRelative().

function layOutLocalItemWithSpec(dataDir: string, id: string, specBody: string): string {
  const itemPath = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemPath, "spec"), { recursive: true });
  writeFileSync(join(itemPath, "spec", "spec.md"), specBody);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  symlinkSync(itemPath, join(dataDir, "system", id));
  return itemPath;
}

test("an ITEM store's history is listed from the shared user-apps repo, not its (repo-less) store root", async () => {
  const { dir, cleanup } = useTestDataDir("history-item-store");
  try {
    layOutLocalItemWithSpec(dir, "widget", "# Widget Spec\n\nv1.\n");
    await listCatalog(); // discovers the item, ensureRepo()s + commits user-apps/

    const userAppsRoot = join(dir, "user-apps");
    commitDirect(userAppsRoot, "items/widget/spec/spec.md", "# Widget Spec\n\nv2.\n", "spec: write spec.md");

    const res = await GET(
      new NextRequest("http://local/api/specs/history?path=item-widget/spec.md"),
    );
    expect(res.status).toBe(200);
    const entries = (await res.json()).history as { hash: string; message: string }[];
    // Two commits touch it: the initial user-apps commit and the edit above.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].message).toContain("spec: write spec.md");

    // ...and each version is readable at its ref — the `git show <ref>:<path>`
    // half of the same bug.
    const newest = await GET(
      new NextRequest(`http://local/api/specs/history?path=item-widget/spec.md&ref=${entries[0].hash}`),
    );
    expect(newest.status).toBe(200);
    expect((await newest.json()).content).toContain("v2");

    const oldest = await GET(
      new NextRequest(`http://local/api/specs/history?path=item-widget/spec.md&ref=${entries[entries.length - 1].hash}`),
    );
    expect(oldest.status).toBe(200);
    expect((await oldest.json()).content).toContain("v1");
  } finally {
    await gitLogger().flush();
    cleanup();
  }
});
