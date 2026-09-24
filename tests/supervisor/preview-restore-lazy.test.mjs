// Reproduction: the Supervisor filled a 155 GB production disk on startup.
//
// `restorePreviews()` scanned git for `bos/*` and eagerly ran, for EVERY
// branch it found, the full provisioning cost:
//
//     const wt = await addWorktreeForBranch(branch);   // + ~1.1 GB node_modules
//     const clone = clonePath(branch);
//     await provisionClone(clone);                     // + a full data-dir copy
//
// — for a preview its own comment describes as "treated as not-built", i.e.
// one nobody has asked for and which may never be used. With 21 abandoned
// `bos/*` branches and an 8.5 GB data dir, a single Supervisor restart tried
// to copy ~200 GB. The clone directories on the production box were stamped
// in alphabetical order, one per minute, until the disk ran out mid-copy at
// `lifecycle-test.provisioning`.
//
// The cost must be paid on FIRST USE, not on discovery. restorePreviews()
// registers what it found; provisionPreview() materializes it.
//
//   node --test tests/supervisor/preview-restore-lazy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeSupervisorEnv, git } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("preview-restore-lazy-");
mkdirSync(join(env.repo, "node_modules"), { recursive: true });
writeFileSync(join(env.repo, "node_modules", ".keep"), "");
// Real content, so "did it copy?" is a question about bytes rather than about
// an empty directory tree.
mkdirSync(join(env.dataDir, "vfs", "Documents"), { recursive: true });
writeFileSync(join(env.dataDir, "vfs", "Documents", "hello.txt"), "canonical content\n");

const { restorePreviews, provisionPreview } = await import("../../tools/supervisor/lib/preview.mjs");
const { state, previews } = await import("../../tools/supervisor/lib/state.mjs");
const { stopProc } = await import("../../tools/supervisor/lib/proc.mjs");
const { initLogStore, getLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(env.dataDir);
await getLogStore()._ready;
state.baseBranch = env.baseBranch;

// The branches that were actually on the production box when it filled up,
// in the order `git branch --list` returns them.
const ABANDONED = [
  "bos/testfixture-agentic-editor-appearance",
  "bos/testfixture-agentic-text-v4",
  "bos/testfixture-core-change",
  "bos/testfixture-feature",
  "bos/testfixture-file-tools-contract",
  "bos/testfixture-follow-money",
  "bos/testfixture-history",
  "bos/testfixture-lifecycle-test",
];

function entries(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
}

test("restorePreviews: discovering N abandoned branches copies NOTHING — no worktree, no data clone", async () => {
  for (const b of ABANDONED) git(env.repo, ["branch", b]);

  await restorePreviews();

  assert.equal(
    entries(env.clones),
    0,
    `restorePreviews must not create a data clone for a branch nobody asked for — this is what copied ~200 GB onto a full disk`,
  );
  assert.equal(entries(env.worktrees), 0, "restorePreviews must not hydrate a worktree (node_modules) either");

  // Discovery still has to HAPPEN — a lazy restore that forgets the branches
  // would trade a disk bug for an invisible-previews bug.
  for (const b of ABANDONED) {
    const p = previews.get(b);
    assert.ok(p, `${b} must still be registered as a restorable preview`);
    assert.equal(p.branch, b);
    assert.equal(p.state, "not-built", "a restored preview is not built");
    assert.equal(p.provisioned, false, "and is explicitly marked as not yet materialized");
  }
});

test("provisionPreview: first real use materializes exactly ONE clone — and only for the branch asked for", async () => {
  const branch = ABANDONED[0];
  const p = await provisionPreview(branch);
  try {
    assert.equal(p.provisioned, true);
    assert.equal(existsSync(p.worktree), true, "the worktree must exist once the preview is actually used");
    assert.equal(existsSync(join(p.dataDir, "vfs", "Documents", "hello.txt")), true, "and so must a real data clone");

    const clonedBranches = readdirSync(join(env.clones, "bos"));
    assert.deepEqual(clonedBranches, [branch.slice("bos/".length)], "no OTHER branch may have been materialized as a side effect");

    // The same object the restore registered, mutated in place — anything
    // holding a reference (publicState, a pin lookup) must see the update
    // rather than a stale dormant twin.
    assert.equal(previews.get(branch), p, "provisioning must update the registered record, not replace it");
  } finally {
    await stopProc(p);
    previews.delete(branch);
  }
});

test("provisionPreview: a second call for an already-materialized preview is a no-op, not a re-copy", async () => {
  const branch = ABANDONED[1];
  const first = await provisionPreview(branch);
  try {
    writeFileSync(join(first.dataDir, "DRIFT"), "the preview wrote this itself\n");
    const second = await provisionPreview(branch);
    assert.equal(second, first);
    assert.equal(existsSync(join(first.dataDir, "DRIFT")), true, "a re-provision must never re-copy over the preview's own data");
  } finally {
    await stopProc(first);
    previews.delete(branch);
  }
});

test.after(() => env.cleanup());
