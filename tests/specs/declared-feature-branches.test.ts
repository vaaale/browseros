// Unit tests for listDeclaredFeatureBranches() (src/lib/agent/conversations-server.ts)
// — added after a real production bug: under the Supervisor, dev_branch_request
// only records a feature branch NAME on the originating conversation's own file;
// the real git branch + worktree aren't created until dev_delegate first runs
// under it (lazy, at delegate time). Until then, system/git.ts's
// listFeatureBranches() (real git refs only) can't see it, so a DIFFERENT
// conversation has no way to select the same branch — this is the merge-in
// that closes that gap.
//
// NOTE: os/vfs.ts caches its data root in a module-level constant computed
// once at import time (correct in production — BOS_DATA_DIR never changes
// mid-process — but it means useTestDataDir()'s per-test override does NOT
// isolate /Documents/Chats/ across tests sharing a worker). So these tests
// use random-ish, collision-proof branch/file names and assert with
// `arrayContaining`/`toContain` against the merged result, never exact
// equality against the full listing — leftover conversation files from
// sibling tests in the same worker are expected to still be present.
//   npm run test:unit -- tests/specs/declared-feature-branches.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import { writeText } from "../../src/os/vfs";
import { listDeclaredFeatureBranches } from "../../src/lib/agent/conversations-server";

function uniqueBranch(tag: string): string {
  return `bos/test-${tag}-${Math.random().toString(36).slice(2, 8)}`;
}

test("collects the distinct activeFeatureBranch from every conversation file", async () => {
  const { cleanup } = useTestDataDir("declared-feature-branches-basic");
  try {
    const branchA = uniqueBranch("a");
    const branchB = uniqueBranch("b");
    const fileA = `c-${Math.random().toString(36).slice(2, 8)}`;
    const fileB = `c-${Math.random().toString(36).slice(2, 8)}`;
    await writeText(`/Documents/Chats/${fileA}.json`, JSON.stringify({ id: fileA, agentId: "build-studio", createdAt: 1, activeFeatureBranch: branchA, messages: [] }));
    await writeText(`/Documents/Chats/${fileB}.json`, JSON.stringify({ id: fileB, agentId: "build-studio", createdAt: 2, activeFeatureBranch: branchB, messages: [] }));

    const branches = await listDeclaredFeatureBranches();
    expect(branches).toEqual(expect.arrayContaining([branchA, branchB]));
  } finally {
    cleanup();
  }
});

test("de-dupes when multiple conversations declared the SAME branch", async () => {
  const { cleanup } = useTestDataDir("declared-feature-branches-dedupe");
  try {
    const shared = uniqueBranch("shared");
    const fileA = `c-${Math.random().toString(36).slice(2, 8)}`;
    const fileB = `c-${Math.random().toString(36).slice(2, 8)}`;
    await writeText(`/Documents/Chats/${fileA}.json`, JSON.stringify({ id: fileA, agentId: "build-studio", createdAt: 1, activeFeatureBranch: shared, messages: [] }));
    await writeText(`/Documents/Chats/${fileB}.json`, JSON.stringify({ id: fileB, agentId: "build-studio", createdAt: 2, activeFeatureBranch: shared, messages: [] }));

    const branches = await listDeclaredFeatureBranches();
    expect(branches.filter((b) => b === shared)).toEqual([shared]); // present exactly once, not twice
  } finally {
    cleanup();
  }
});

test("skips a corrupt conversation file instead of failing the whole listing", async () => {
  const { cleanup } = useTestDataDir("declared-feature-branches-corrupt");
  try {
    const good = uniqueBranch("good");
    const corruptFile = `c-corrupt-${Math.random().toString(36).slice(2, 8)}`;
    const goodFile = `c-${Math.random().toString(36).slice(2, 8)}`;
    await writeText(`/Documents/Chats/${corruptFile}.json`, "{ not valid json");
    await writeText(`/Documents/Chats/${goodFile}.json`, JSON.stringify({ id: goodFile, agentId: "build-studio", createdAt: 1, activeFeatureBranch: good, messages: [] }));

    const branches = await listDeclaredFeatureBranches();
    expect(branches).toContain(good);
  } finally {
    cleanup();
  }
});

test("ignores an invalid (non bos/*) activeFeatureBranch value rather than surfacing garbage", async () => {
  const { cleanup } = useTestDataDir("declared-feature-branches-invalid");
  try {
    const file = `c-${Math.random().toString(36).slice(2, 8)}`;
    const bogus = `not-a-real-branch-name-${Math.random().toString(36).slice(2, 8)}`;
    await writeText(`/Documents/Chats/${file}.json`, JSON.stringify({ id: file, agentId: "build-studio", createdAt: 1, activeFeatureBranch: bogus, messages: [] }));

    expect(await listDeclaredFeatureBranches()).not.toContain(bogus);
  } finally {
    cleanup();
  }
});
