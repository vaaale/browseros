// 035-spec-promote-conflict-escalation — the resolution session store: its
// state machine, its durability, the operation completion it owns, and the
// boot sweep's classification (T011, T018, T035).
//
//   npm run test:unit -- tests/gitops/conflict-session-store.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Each test gets its own data dir, so the session store's warm index and its
 *  files never leak between tests. `dataDir()` reads the env at call time. */
function useTempDataDir(): { data: string; cleanup: () => void } {
  const data = mkdtempSync(join(tmpdir(), "conflict-data-"));
  // RESTORE the previous value on cleanup. Playwright runs several test FILES
  // in one worker process, so leaving BOS_DATA_DIR pointing at a directory
  // this test then deletes would break every later test in that worker.
  const previous = process.env.BOS_DATA_DIR;
  process.env.BOS_DATA_DIR = data;
  return {
    data,
    cleanup: () => {
      if (previous === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previous;
      rmSync(data, { recursive: true, force: true });
    },
  };
}

/** The add/add repro repo: `main` and `feature` each add the same path. */
function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "conflict-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(dir, "notes.md"), "main side\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "main adds notes"]);
  git(dir, ["checkout", "-q", "-b", "feature", "HEAD~1"]);
  writeFileSync(join(dir, "notes.md"), "feature side\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feature adds notes"]);
  git(dir, ["checkout", "-q", "main"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function store() {
  return import("../../src/lib/gitops/sessions/store");
}

async function newSession(repo: string, overrides: Record<string, unknown> = {}) {
  const s = await store();
  const { snapshot } = await s.captureSnapshot(repo, "main", "feature");
  return s.createSession({
    workContext: {
      repoKind: "user-specs",
      repoPath: repo,
      repoRoot: repo,
      baseRef: snapshot.base,
      oursRef: "main",
      theirsRef: "feature",
      mode: "working-tree",
      label: "user-specs store",
    },
    featureBranch: "feature",
    baseBranch: "main",
    rollbackTag: "bos/pre-reconcile-test",
    conversationId: "c-test",
    agentId: "devops",
    snapshot,
    completion: { kind: "merge", strategy: "merge" },
    operationLabel: "spec promote",
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof store>>["createSession"]>[0]);
}

test("captureSnapshot records the three refs and the conflicting file list", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const { snapshot } = await s.captureSnapshot(repo.dir, "main", "feature");
    expect(snapshot.ours).toBe("main");
    expect(snapshot.theirs).toBe("feature");
    expect(snapshot.base).toBe(git(repo.dir, ["merge-base", "main", "feature"]));
    expect(snapshot.files).toContain("notes.md");
    expect(snapshot.types?.["notes.md"]).toBe("add/add");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("createSession persists a durable file and starts in `working`", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const session = await newSession(repo.dir);
    expect(session.status).toBe("working");
    expect(session.pendingDecision).toBeNull();
    expect(session.files.map((f) => f.path)).toEqual(["notes.md"]);

    const file = join(data.data, "gitops", "sessions", `${session.id}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).id).toBe(session.id);
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("readThreeWay derives the three sides from refs, with a null base for add/add", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    const three = await s.readThreeWay(session, "notes.md");
    expect(three.binary).toBe(false);
    expect(three.base).toBeNull(); // add/add — absent at the merge base
    expect(three.ours).toBe("main side\n");
    expect(three.theirs).toBe("feature side\n");
    expect(three.hunks.length).toBeGreaterThan(0);
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("a decision parks the session in `awaiting-user` and is answerable exactly once", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    const decision = await s.askDecision(session.id, { question: "which side?", path: "notes.md" });

    const parked = await s.getSession(session.id);
    expect(parked!.status).toBe("awaiting-user");
    expect(parked!.pendingDecision?.id).toBe(decision.id);
    // Park-and-rewake: the run is released, never pinned by an open promise.
    expect(parked!.runId).toBeNull();

    // The pane can't answer a session that isn't parked, and can't answer the
    // same decision twice.
    const answered = await s.answerDecision(session.id, { decisionId: decision.id, optionId: "theirs" });
    expect(answered.status).toBe("working");
    expect(answered.pendingDecision).toBeNull();
    expect(answered.decisions[0].answer?.optionId).toBe("theirs");
    // "theirs" is derivable, so it lands as a resolution without another agent turn.
    expect(answered.files[0].resolvedContent).toBe("feature side\n");
    expect(answered.files[0].resolvedBy).toBe("user");

    await expect(s.answerDecision(session.id, { optionId: "ours" })).rejects.toThrow(/not awaiting a decision/);
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("answering `keep-both` and `manual` produce the expected merged content", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const a = await newSession(repo.dir);
    await s.askDecision(a.id, { question: "?", path: "notes.md" });
    const both = await s.answerDecision(a.id, { optionId: "keep-both" });
    expect(both.files[0].resolvedContent).toBe("main side\nfeature side\n");

    const b = await newSession(repo.dir);
    await s.askDecision(b.id, { question: "?", path: "notes.md" });
    const manual = await s.answerDecision(b.id, { optionId: "manual", manualText: "hand merged\n" });
    expect(manual.files[0].resolvedContent).toBe("hand merged\n");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("conflict_write's recording lands the content in the working tree and clears the file", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    expect(s.unresolvedFiles(session)).toEqual(["notes.md"]);
    const updated = await s.recordResolution(session.id, "notes.md", "merged by the agent\n", "agent");
    expect(s.unresolvedFiles(updated)).toEqual([]);
    expect(readFileSync(join(repo.dir, "notes.md"), "utf8")).toBe("merged by the agent\n");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("completeSession refuses while a file is unresolved, then completes the merge", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    await expect(s.completeSession(session.id)).rejects.toThrow(/still unresolved/);

    await s.recordResolution(session.id, "notes.md", "merged\n", "agent");
    const done = await s.completeSession(session.id, "kept both sides' intent");
    expect(done.status).toBe("resolved");
    expect(done.result?.kind).toBe("resolved");

    // A real merge commit landed, with both sides as parents, and the tree is
    // clean — nothing is left conflicted.
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(repo.dir, "notes.md"), "utf8")).toBe("merged\n");
    expect(git(repo.dir, ["rev-list", "--count", "--merges", "HEAD"])).toBe("1");
    expect(git(repo.dir, ["merge-base", "--is-ancestor", "feature", "HEAD"]) === "").toBe(true);
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("a waived (binary) conflict fails the session instead of silently completing (FR-022)", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    await s.waiveFile(session.id, "notes.md", "binary file — needs manual handling");
    const done = await s.completeSession(session.id);
    expect(done.status).toBe("failed");
    expect(done.result?.error).toMatch(/require manual handling/);
    expect(done.result?.error).toContain("notes.md");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("recordResolution refuses to write text over a binary conflict", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    session.files[0].binary = true;
    await expect(s.recordResolution(session.id, "notes.md", "nope\n", "agent")).rejects.toMatchObject({
      code: "BINARY_CONFLICT",
    });
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("abandoning rolls the working tree back to the rollback tag (FR-011/FR-017)", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    git(repo.dir, ["tag", "-a", "bos/pre-reconcile-test", "-m", "anchor"]);
    const before = git(repo.dir, ["rev-parse", "HEAD"]);
    const session = await newSession(repo.dir);
    // Simulate a half-done resolution left in the tree.
    await s.recordResolution(session.id, "notes.md", "half done\n", "agent");

    const done = await s.abandonSession(session.id);
    expect(done.status).toBe("abandoned");
    expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(repo.dir, "notes.md"), "utf8")).toBe("main side\n");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("completion fast-forwards the base branch when the plan asks for it (FR-017)", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    // Reconcile main INTO the feature branch, in a linked worktree, exactly as
    // promoteFeature does — then main only ever fast-forwards.
    const wt = mkdtempSync(join(tmpdir(), "conflict-wt-"));
    rmSync(wt, { recursive: true, force: true });
    git(repo.dir, ["worktree", "add", "-q", wt, "feature"]);
    const { snapshot } = await s.captureSnapshot(wt, "feature", "main");
    const session = await s.createSession({
      workContext: {
        repoKind: "user-specs",
        repoPath: wt,
        repoRoot: repo.dir,
        baseRef: snapshot.base,
        oursRef: "feature",
        theirsRef: "main",
        mode: "working-tree",
        label: "user-specs store",
      },
      featureBranch: "feature",
      baseBranch: "main",
      rollbackTag: "",
      conversationId: "c-ff",
      agentId: "devops",
      snapshot,
      completion: {
        kind: "merge",
        strategy: "merge",
        ff: { repoRoot: repo.dir, baseBranch: "main", ffBranch: "feature" },
      },
      operationLabel: "spec promote",
    });
    await s.recordResolution(session.id, "notes.md", "reconciled\n", "agent");
    const done = await s.completeSession(session.id);
    expect(done.status).toBe("resolved");

    // main fast-forwarded onto the reconciled feature branch and was never
    // itself in a conflicted state.
    expect(git(repo.dir, ["rev-parse", "main"])).toBe(git(repo.dir, ["rev-parse", "feature"]));
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("plumbing completion advances the base ref without touching the checkout", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    // The Supervisor's busy-checkout case: HEAD is parked on some OTHER branch
    // (as app-candidate would leave it) and must not be disturbed.
    git(repo.dir, ["checkout", "-q", "-b", "app-candidate"]);
    const headBefore = git(repo.dir, ["rev-parse", "HEAD"]);
    const treeBefore = readFileSync(join(repo.dir, "notes.md"), "utf8");

    const { snapshot } = await s.captureSnapshot(repo.dir, "main", "feature");
    const session = await s.createSession({
      workContext: {
        repoKind: "user-apps",
        repoPath: repo.dir,
        repoRoot: repo.dir,
        baseRef: snapshot.base,
        oursRef: "main",
        theirsRef: "feature",
        mode: "plumbing",
        label: "user-apps",
      },
      featureBranch: "feature",
      baseBranch: "main",
      rollbackTag: "",
      conversationId: "c-plumb",
      agentId: "devops",
      snapshot,
      completion: { kind: "plumbing-merge", strategy: "merge", plumbingBaseBranch: "main" },
      operationLabel: "feature promote (coupled repo)",
    });
    await s.recordResolution(session.id, "notes.md", "plumbed merge\n", "agent");
    const done = await s.completeSession(session.id);
    expect(done.status).toBe("resolved");

    // The ref advanced with a real two-parent merge commit...
    expect(git(repo.dir, ["rev-parse", "main"])).not.toBe(snapshot.ours);
    expect(git(repo.dir, ["show", "main:notes.md"])).toBe("plumbed merge");
    expect(git(repo.dir, ["rev-list", "--count", "--merges", "main"])).toBe("1");
    // ...and the live checkout was never touched.
    expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(join(repo.dir, "notes.md"), "utf8")).toBe(treeBefore);
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("the concurrent-op guard treats a parked `awaiting-user` session as still active (S12)", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    await s.askDecision(session.id, { question: "?", path: "notes.md" });

    // A session parked indefinitely on the user must still block a second
    // pipeline against the same repo — the caller re-points to it.
    const active = await s.findActiveSessionForRepo(repo.dir);
    expect(active?.id).toBe(session.id);
    expect(active?.status).toBe("awaiting-user");
    expect((await s.listActiveSessions()).map((x) => x.id)).toContain(session.id);

    await s.abandonSession(session.id);
    expect(await s.findActiveSessionForRepo(repo.dir)).toBeUndefined();
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("assertWorkContextUsable fails loudly on an unusable working context (FR-021)", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    await s.assertWorkContextUsable(session); // the real repo is fine

    const notARepo = mkdtempSync(join(tmpdir(), "conflict-notrepo-"));
    try {
      const bad = { ...session, workContext: { ...session.workContext, repoPath: notARepo, repoRoot: notARepo } };
      await expect(s.assertWorkContextUsable(bad)).rejects.toMatchObject({ code: "NO_WORK_CONTEXT" });
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("the boot sweep re-launches `working`, restores `awaiting-user`, and skips terminal (FR-024)", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const { recoverSessions } = await import("../../src/lib/gitops/sessions/recover");

    const working = await newSession(repo.dir);
    const parked = await newSession(repo.dir);
    await s.askDecision(parked.id, { question: "?", path: "notes.md" });
    const terminal = await newSession(repo.dir);
    await s.abandonSession(terminal.id);

    const relaunched: string[] = [];
    const emitted: string[] = [];
    const report = await recoverSessions({
      relaunch: async (session, message) => {
        relaunched.push(session.id);
        // The resume prompt must point the agent back at its own state, not
        // ask it to start over.
        expect(message).toContain("conflict_status");
      },
      emit: async (session) => {
        emitted.push(session.id);
      },
      clearRun: async () => {},
    });

    expect(report.relaunched).toEqual([working.id]);
    expect(relaunched).toEqual([working.id]);
    expect(report.restored).toEqual([parked.id]);
    // Both non-terminal sessions re-emit (so the pane re-opens); the terminal
    // one is skipped entirely.
    expect(emitted.sort()).toEqual([parked.id, working.id].sort());
    expect(emitted).not.toContain(terminal.id);
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});

test("a session survives a process restart: the store re-reads it from disk", async () => {
  const data = useTempDataDir();
  const repo = makeRepo();
  try {
    const s = await store();
    const session = await newSession(repo.dir);
    await s.askDecision(session.id, { question: "which side is canonical?", path: "notes.md" });

    // Simulate the restart: drop the warm index, exactly as a fresh process
    // would have it, and re-read from the durable file.
    delete (globalThis as unknown as Record<string, unknown>).__bosConflictSessions;
    const restored = await s.getSession(session.id);
    expect(restored!.status).toBe("awaiting-user");
    expect(restored!.pendingDecision?.question).toBe("which side is canonical?");
    expect(restored!.snapshot.files).toEqual(["notes.md"]);

    // The three-way content is RE-DERIVED from the refs, identical to before.
    const three = await s.readThreeWay(restored!, "notes.md");
    expect(three.ours).toBe("main side\n");
    expect(three.theirs).toBe("feature side\n");
  } finally {
    repo.cleanup();
    data.cleanup();
  }
});
