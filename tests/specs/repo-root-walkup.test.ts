// 050 T001 — a store root may be a SUBDIRECTORY of its repo.
//   npm run test:unit -- tests/specs/repo-root-walkup.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { listStores } from "../../src/lib/specs/stores";

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# app\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: dir });
}

test("a project repo's specs subdirectory is discovered, with the REPO as repoRoot", async () => {
  // An arbitrary repo keeps its specs where the framework's own CLI expects
  // them — `<repo>/openspec` — so the store root is that folder and the repo is
  // its parent. Requiring the store dir itself to be a git repo skipped exactly
  // those, silently: a store that never appears looks like one never added.
  const { dir, cleanup } = useTestDataDir("repo-root-walkup");
  try {
    const repo = join(dir, "projects", "invoice-parser");
    gitInit(repo);
    const storeRoot = join(repo, "openspec");
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(
      join(storeRoot, "spec-store.json"),
      JSON.stringify({ label: "Invoice Parser", owner: "user", writable: true }),
    );

    mkdirSync(specsRoot(), { recursive: true });
    symlinkSync(storeRoot, join(specsRoot(), "invoice-parser"), "dir");

    const store = (await listStores()).find((s) => s.id === "invoice-parser");
    expect(store, "a subdirectory store root is discovered").toBeDefined();
    // `root` stays the symlink path — that is what spec-fs jails to, and it
    // resolves through the link. What must differ is the REPO.
    expect(store!.repoRoot, "git runs in the REPO, not the subdirectory").toBe(repo);
    expect(store!.repoRoot).not.toBe(store!.root);
  } finally {
    cleanup();
  }
});

test("a store that IS its own repo is unchanged — one rule, three shapes", async () => {
  const { cleanup } = useTestDataDir("repo-root-selfrepo");
  try {
    const { ensureStores } = await import("../../src/lib/specs/seed");
    await ensureStores();
    const user = (await listStores()).find((s) => s.id === "user-specs")!;
    expect(user.repoRoot, "matches on the first step").toBe(user.root);
  } finally {
    cleanup();
  }
});

test("an unversioned directory does NOT attach to whatever repo sits above it", async () => {
  // The bound is the point. An unbounded walk-up finds BOS's own checkout for
  // anything under the data dir, which would version a user's specs in BOS's
  // repo and accept git writes against it.
  const { dir, cleanup } = useTestDataDir("repo-root-none");
  try {
    const loose = join(dir, "loose-specs");
    mkdirSync(loose, { recursive: true });
    writeFileSync(join(loose, "spec-store.json"), JSON.stringify({ label: "Loose", owner: "user", writable: true }));
    mkdirSync(specsRoot(), { recursive: true });
    symlinkSync(loose, join(specsRoot(), "loose"), "dir");
    expect((await listStores()).some((s) => s.id === "loose"), "not a store, and not adopted by an ancestor repo").toBe(false);
  } finally {
    cleanup();
  }
});
