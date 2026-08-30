// 035-spec-promote-conflict-escalation — the refs-based snapshot primitives
// (T011). These are the load-bearing pieces of the whole design decision that
// the snapshot comes from REFS, never from `:1:`/`:2:`/`:3:` merge-index
// stages: the pipeline ABORTS the merge before it escalates, so the stages are
// gone by then, and only the refs survive both that abort and a restart.
//
//   npm run test:unit -- tests/gitops/conflict-snapshot.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import {
  readFileAtRef,
  looksBinary,
  readFileAtRefBuffer,
  parseMergeTreeConflicts,
  mergeTreeConflicts,
  mergeFileWithMarkers,
} from "../../src/lib/gitops/git-ops";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A repo with an add/add conflict — the exact shape of the reported repro:
 *  two branches each ADD the same path with different content, so the file is
 *  absent at the merge base. */
function makeAddAddRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "conflict-snapshot-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  writeFileSync(join(dir, "test-results.md"), "# main version\ncoverage: 88%\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "main adds test-results"]);

  git(dir, ["checkout", "-q", "-b", "feature", "HEAD~1"]);
  writeFileSync(join(dir, "test-results.md"), "# feature version\ncoverage: 92%\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feature adds test-results"]);
  git(dir, ["checkout", "-q", "main"]);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readFileAtRef returns byte-exact content at a ref", async () => {
  const { dir, cleanup } = makeAddAddRepo();
  try {
    expect(await readFileAtRef(dir, "main", "test-results.md")).toBe("# main version\ncoverage: 88%\n");
    expect(await readFileAtRef(dir, "feature", "test-results.md")).toBe("# feature version\ncoverage: 92%\n");
  } finally {
    cleanup();
  }
});

test("readFileAtRef returns null for the add/add base side instead of throwing", async () => {
  // The critical path for the reported repro: `git show <merge-base>:<rel>`
  // FAILS because the file genuinely does not exist at the fork point. That
  // must surface as an empty base side, not as an error that kills the
  // snapshot.
  const { dir, cleanup } = makeAddAddRepo();
  try {
    const base = git(dir, ["merge-base", "main", "feature"]);
    expect(base).toBeTruthy();
    expect(await readFileAtRef(dir, base, "test-results.md")).toBeNull();
  } finally {
    cleanup();
  }
});

test("readFileAtRef returns null for an unknown ref rather than throwing", async () => {
  const { dir, cleanup } = makeAddAddRepo();
  try {
    expect(await readFileAtRef(dir, "no-such-ref", "test-results.md")).toBeNull();
    expect(await readFileAtRef(dir, "", "test-results.md")).toBeNull();
  } finally {
    cleanup();
  }
});

test("looksBinary flags a NUL-containing blob and not a text one", async () => {
  const { dir, cleanup } = makeAddAddRepo();
  try {
    writeFileSync(join(dir, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "binary"]);
    expect(looksBinary(await readFileAtRefBuffer(dir, "main", "logo.bin"))).toBe(true);
    expect(looksBinary(await readFileAtRefBuffer(dir, "main", "README.md"))).toBe(false);
    expect(looksBinary(null)).toBe(false);
  } finally {
    cleanup();
  }
});

test("parseMergeTreeConflicts unions the stage lines and the CONFLICT messages", () => {
  const out = [
    "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "100644 1111111111111111111111111111111111111111 2\tcore-platform/034/test-results.md",
    "100644 2222222222222222222222222222222222222222 3\tcore-platform/034/test-results.md",
    "",
    "CONFLICT (add/add): Merge conflict in core-platform/034/test-results.md",
    "CONFLICT (content): Merge conflict in src/lib/other.ts",
  ].join("\n");
  const parsed = parseMergeTreeConflicts(out);
  expect(parsed.files.sort()).toEqual(["core-platform/034/test-results.md", "src/lib/other.ts"]);
  expect(parsed.types["core-platform/034/test-results.md"]).toBe("add/add");
});

test("mergeTreeConflicts reports the conflicting file with no working tree involved", async () => {
  const { dir, cleanup } = makeAddAddRepo();
  try {
    const base = git(dir, ["merge-base", "main", "feature"]);
    const conflicts = await mergeTreeConflicts(dir, base, "main", "feature");
    expect(conflicts).not.toBeNull();
    expect(conflicts!.files).toContain("test-results.md");
    // Crucially, the working tree is untouched by the dry run.
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  } finally {
    cleanup();
  }
});

test("mergeTreeConflicts returns null for a clean merge", async () => {
  const { dir, cleanup } = makeAddAddRepo();
  try {
    git(dir, ["checkout", "-q", "-b", "clean", "main"]);
    writeFileSync(join(dir, "unrelated.md"), "no overlap\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "unrelated"]);
    const base = git(dir, ["merge-base", "main", "clean"]);
    expect(await mergeTreeConflicts(dir, base, "main", "clean")).toBeNull();
  } finally {
    cleanup();
  }
});

test("mergeFileWithMarkers renders diff3 markers over the three ref contents", async () => {
  const markers = await mergeFileWithMarkers(null, "# feature version\n", "# main version\n", {
    ours: "ours",
    base: "base",
    theirs: "theirs",
  });
  expect(markers).not.toBeNull();
  expect(markers).toContain("<<<<<<< ours");
  expect(markers).toContain("=======");
  expect(markers).toContain(">>>>>>> theirs");
  expect(markers).toContain("# feature version");
  expect(markers).toContain("# main version");
});
