// VFS file tools × real container paths (self-heal case 0026).
//   npm run test:unit -- tests/assistant/file-container-path.test.ts
//
// The defect: the file_* tools only resolve VFS paths, but when handed a real
// on-disk container path (e.g. an installed item's worktree under
// /data-clones/...) they failed without saying the NAMESPACE was wrong —
// file_grep said `no file at '<path>'`, file_edit/file_patch surfaced a raw
// ENOENT, and file_search/file_glob silently returned []. A capable agent
// reads those as transient/typo failures and repeats the identical wrong
// call, which is what fired the repeated-failure self-heal case. The fix is
// ONE shared classifier (first path segment ∈ the container-root set that
// mirrors self-heal/signature.ts) + ONE shared diagnostic that names the
// correct alternative (app_spec_read for item spec artifacts, run_command
// otherwise). On the unfixed base every test in the first two sections fails.

import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import {
  fileTools,
  isRealContainerPath,
  containerPathDiagnostic,
} from "../../src/lib/assistant/tools/server/files";
import { writeText } from "../../src/os/vfs";
import type { ToolContext } from "../../src/lib/assistant/tools";

const RUN_ID = "run-container-path";
const ctx = { conversationId: RUN_ID, runId: RUN_ID, agentId: "ephemeral-test" } as unknown as ToolContext;

// The exact path shape from the original incident: an installed item's spec
// artifact inside its /data-clones worktree.
const ITEM_ARTIFACT = "/data-clones/bos/testfixture-follow-the-money/user-apps/items/follow-the-money/spec/design.md";
const GENERIC_CONTAINER = "/app/data/system/notes/manifest.json";

async function run(tool: string, input: Record<string, unknown>): Promise<string> {
  const raw = await fileTools()[tool].execute!(input, ctx);
  return typeof raw === "string" ? raw : raw.text;
}

let env: { dir: string; cleanup: () => void };
test.beforeEach(() => {
  env = useTestDataDir("file-container-path");
});
test.afterEach(() => {
  env.cleanup();
});

// ── The shared classifier + diagnostic ───────────────────────────────────────

test("classifier: container roots match on the FULL first segment only", () => {
  for (const p of [
    ITEM_ARTIFACT,
    GENERIC_CONTAINER,
    "/home/user/notes.md",
    "/tmp/x.txt",
    "/worktrees/bos/foo/src/a.ts",
    "/var/log/bos.log",
    "//app/double-slash.txt",
  ]) {
    expect(isRealContainerPath(p), `expected container path: ${p}`).toBe(true);
  }
  for (const p of [
    "/Documents/notes.md",
    "/Docs/does-not-exist.txt",
    "/Specs/user-specs/never-written/spec.md",
    "/workspace/app-notes", // first segment 'workspace', NOT 'app'
    "/application/x.txt", // 'application' must not prefix-match 'app'
    "/homework/essay.md", // 'homework' must not prefix-match 'home'
    "/Methods/spec-kit/templates/spec.md",
    "relative/app/path.txt", // first segment is 'relative'
    "",
    "/",
  ]) {
    expect(isRealContainerPath(p), `expected VFS/non-container path: ${p}`).toBe(false);
  }
});

test("diagnostic for an item spec artifact names app_spec_read with the store-prefixed path", () => {
  const msg = containerPathDiagnostic(ITEM_ARTIFACT);
  // (a) says the namespace is wrong: file_* sees only VFS paths.
  expect(msg).toContain("not a VFS path");
  expect(msg).toContain("file_*");
  // (b) names the correct alternatives — including the exact corrected call.
  expect(msg).toContain("app_spec_read('item-follow-the-money/design.md')");
  expect(msg).toContain("app_spec_list('item-follow-the-money')");
  expect(msg).toContain("run_command");
});

test("diagnostic for a generic container path names run_command and skips the app_spec noise", () => {
  const msg = containerPathDiagnostic(GENERIC_CONTAINER);
  expect(msg).toContain("not a VFS path");
  expect(msg).toContain("run_command");
  expect(msg).not.toContain("app_spec_read");
});

// ── Each tool's failure path surfaces the diagnostic ─────────────────────────

test("file_grep on a container path explains the namespace instead of 'no file at'", async () => {
  const raw = await run("file_grep", { path: ITEM_ARTIFACT, pattern: "design" });
  expect(raw).toMatch(/^Error: file_grep:/);
  expect(raw).toContain("not a VFS path");
  expect(raw).toContain("app_spec_read('item-follow-the-money/design.md')");
  expect(raw).toContain("run_command");
  expect(raw).not.toContain("no file at");
});

test("file_search on a container root errors loudly instead of a silent []", async () => {
  const raw = await run("file_search", { path: "/data-clones/bos/testfixture-follow-the-money", query: "design" });
  expect(raw).toMatch(/^Error: file_search:/);
  expect(raw).toContain("not a VFS path");
  expect(raw).toContain("run_command");
});

test("file_glob on a container root errors loudly instead of a silent []", async () => {
  const raw = await run("file_glob", { path: "/app/data", pattern: "**/*.md" });
  expect(raw).toMatch(/^Error: file_glob:/);
  expect(raw).toContain("not a VFS path");
});

test("file_edit / file_patch on a container path explain the namespace instead of a raw ENOENT", async () => {
  const edit = await run("file_edit", { path: ITEM_ARTIFACT, find: "a", replace: "b" });
  expect(edit).toMatch(/^Error: file_edit:/);
  expect(edit).toContain("not a VFS path");
  expect(edit).not.toMatch(/no such file or directory/i);

  const patch = await run("file_patch", { path: GENERIC_CONTAINER, hunks: [{ find: "a", replace: "b" }] });
  expect(patch).toMatch(/^Error: file_patch:/);
  expect(patch).toContain("not a VFS path");
  expect(patch).toContain("run_command");
  expect(patch).not.toMatch(/no such file or directory/i);
});

// ── No false positives: genuinely-missing VFS paths keep their old behaviour ─

test("a missing VFS path keeps the existing non-container errors (no misdiagnosis)", async () => {
  const grep = await run("file_grep", { path: "/Docs/does-not-exist.txt", pattern: "x" });
  expect(grep).toMatch(/^Error: file_grep:/);
  expect(grep).toMatch(/no file at/);
  expect(grep).not.toContain("not a VFS path");

  const edit = await run("file_edit", { path: "/Documents/never-written.md", find: "a", replace: "b" });
  expect(edit).toMatch(/^Error: file_edit:/);
  expect(edit).not.toContain("not a VFS path");
});

test("a missing VFS directory still yields [] from file_search / file_glob (unchanged)", async () => {
  const search = JSON.parse(await run("file_search", { path: "/Documents/no-such-dir", query: "x" }));
  expect(search).toEqual([]);
  const glob = JSON.parse(await run("file_glob", { path: "/Documents/no-such-dir", pattern: "**" }));
  expect(glob).toEqual([]);
});

test("real VFS paths still work end-to-end (the guard never fires on them)", async () => {
  const file = "/Documents/workspace-lab/app-notes.md"; // 'workspace'-adjacent name, still VFS
  await writeText(file, "alpha\nneedle here\n");
  const grep = JSON.parse(await run("file_grep", { path: file, pattern: "needle" }));
  expect(grep.matchCount).toBe(1);
  expect(await run("file_edit", { path: file, find: "alpha", replace: "beta" })).toContain("Edited");
});
