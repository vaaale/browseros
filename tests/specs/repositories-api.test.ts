// 050 Phase 3 — the Repositories page's data (FR-010a, FR-010b).
//   npm run test:unit -- tests/specs/repositories-api.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { ensureStores } from "../../src/lib/specs/seed";
import { GET } from "../../src/app/api/repositories/route";
import type { RepositoryRow } from "../../src/app/api/repositories/route";

async function rows(): Promise<RepositoryRow[]> {
  const res = await GET();
  return ((await res.json()) as { repositories: RepositoryRow[] }).repositories;
}

test("every row carries the two things the old layout needed a click for", async () => {
  const { cleanup } = useTestDataDir("repos-api-rows");
  try {
    await ensureStores();
    const all = await rows();
    const user = all.find((r) => r.id === "user-specs")!;
    expect(user.kind, "KIND, at a glance").toBe("user-specs");
    expect(typeof user.uncommitted, "and whether there is unsaved work").toBe("number");
    expect(typeof user.branch).toBe("string");

    const sys = all.find((r) => r.id === "bos-system-specs")!;
    expect(sys.removable, "BOS's own stores are not removable").toBe(false);
    expect(user.removable).toBe(false);
  } finally {
    cleanup();
  }
});

test("uncommitted and unpushed work is counted, including on a never-pushed branch", async () => {
  // A `bos/*` branch with no upstream is the common case, and reporting 0
  // unpushed there would be the dangerous answer — it is exactly the work a
  // delete would lose.
  const { cleanup } = useTestDataDir("repos-api-dirty");
  try {
    await ensureStores();
    const root = join(specsRoot(), "user-specs");
    execFileSync("git", ["checkout", "-q", "-b", "bos/testfixture-never-pushed"], { cwd: root });
    writeFileSync(join(root, "note.md"), "# committed but never pushed\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"], { cwd: root });
    writeFileSync(join(root, "dirty.md"), "# not committed\n");

    const user = (await rows()).find((r) => r.id === "user-specs")!;
    expect(user.branch).toBe("bos/testfixture-never-pushed");
    expect(user.uncommitted, "an uncommitted file is counted").toBeGreaterThan(0);
    expect(user.unpushed, "and so is a commit no remote has").toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("FR-010b — a registered repository whose link is dead shows as BROKEN, not hidden", async () => {
  // listStores() skips it, correctly: it cannot be read. A page that also hides
  // it leaves the disappearance with no explanation.
  const { dir, cleanup } = useTestDataDir("repos-api-broken");
  try {
    await ensureStores();
    symlinkSync(join(dir, "gone-forever"), join(specsRoot(), "ghost"), "dir");

    const ghost = (await rows()).find((r) => r.id === "ghost");
    expect(ghost, "it still appears").toBeDefined();
    expect(ghost!.broken).toBe(true);
    expect(ghost!.problem, "and says what is wrong").toContain("no longer exists");
    expect(ghost!.removable, "so it can be cleaned up").toBe(true);
  } finally {
    cleanup();
  }
});

test("item stores are projects inside their marketplace, not repositories", async () => {
  const { dir, cleanup } = useTestDataDir("repos-api-items");
  try {
    await ensureStores();
    mkdirSync(join(dir, "user-apps", "items", "my-app", "spec"), { recursive: true });
    writeFileSync(join(dir, "user-apps", "items", "my-app", "spec", "spec.md"), "# App\n");
    const all = await rows();
    expect(all.some((r) => r.id.startsWith("item-")), "one repo listed a dozen times is not a repository list").toBe(false);
  } finally {
    cleanup();
  }
});

// The page shows a specific remedy for a repository bound to a workflow that is
// not installed (an "Open Marketplace" button), so the condition has to be a
// FIELD. Deciding it by matching on the wording of `problem` is how that button
// ends up on a git failure that happens to contain the word "method".
test("a workflow that is not installed is flagged as such, not just described", async () => {
  const { cleanup } = useTestDataDir("repos-api-workflow-missing");
  try {
    await ensureStores();
    const root = join(specsRoot(), "user-specs");
    writeFileSync(
      join(root, "spec-store.json"),
      JSON.stringify({ label: "user-specs", owner: "user", writable: true, requiresPromote: false, workflow: "no-such-pack" }),
    );

    const row = (await rows()).find((r) => r.id === "user-specs")!;
    expect(row.workflowMissing).toBe(true);
    expect(row.problem, "and still says which one, so it can be installed").toContain("no-such-pack");
  } finally {
    cleanup();
  }
});

// "32 items · each item binds its own workflow" — the count is what makes the
// per-item binding rule concrete rather than abstract.
test("a marketplace repo reports how many items it holds", async () => {
  const { cleanup } = useTestDataDir("repos-api-item-count");
  try {
    await ensureStores();
    const { registerRepository } = await import("../../src/lib/specs/repositories");
    const repo = await registerRepository({ id: "shop", kind: "marketplace" });
    writeFileSync(
      join(repo.repoRoot, "marketplace.json"),
      JSON.stringify({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    );

    const row = (await rows()).find((r) => r.id === "shop")!;
    expect(row.itemCount).toBe(3);

    // A repo with no manifest yet is a real state, not a failure: it reports no
    // count rather than 0, which would claim the marketplace is empty.
    const bare = await registerRepository({ id: "bare", kind: "marketplace" });
    expect(bare.id).toBe("bare");
    expect((await rows()).find((r) => r.id === "bare")!.itemCount).toBeUndefined();
  } finally {
    cleanup();
  }
});

// `user-apps` (the local marketplace) and `bos-src` (BrowserOS's own checkout)
// are real repositories with real remotes, and NEITHER has a spec store — a
// marketplace's stores are its items, and BOS's source is code. So a page built
// from `listStores()` alone showed neither, which is how they disappeared once
// remotes moved out of one flat list and into the repository rows: their
// Pull/Push went with them.
test("the marketplace and BOS's own source are listed, though neither is a spec store", async () => {
  const { cleanup } = useTestDataDir("repos-api-non-store");
  try {
    await ensureStores();
    const all = await rows();

    const apps = all.find((r) => r.id === "user-apps");
    expect(apps, "the local marketplace is a repository").toBeTruthy();
    expect(apps!.kind).toBe("marketplace");
    expect(apps!.bindingScope, "its projects are its items, each binding its own").toBe("project");
    expect(apps!.removable, "BOS's own — removing it would break the running system").toBe(false);

    const src = all.find((r) => r.id === "bos-src");
    expect(src, "BrowserOS's own checkout is a repository too").toBeTruthy();
    expect(src!.kind).toBe("source");
    expect(src!.bindingScope, "code, not a spec store — it binds no workflow").toBe("none");
    expect(src!.removable).toBe(false);
    expect(typeof src!.branch, "and its unsaved work is visible at a glance").toBe("string");

    // Listed ONCE. Both are discovered by a GitFS scan that also yields every
    // spec store, so a join that forgot to exclude the ones already present
    // would double every row on the page.
    expect(all.filter((r) => r.id === "user-specs")).toHaveLength(1);
    expect(all.filter((r) => r.id === "bos-system-specs")).toHaveLength(1);
    expect(new Set(all.map((r) => r.id)).size, "no duplicates at all").toBe(all.length);
  } finally {
    cleanup();
  }
});
