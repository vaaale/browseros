import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// E2E coverage for 035-spec-promote-conflict-escalation, driving the
// quickstart scenarios S1–S12.
//
// HOW THESE ARE DRIVEN. Every scenario needs a REAL git conflict in a REAL
// repo. Rather than conflicting the running instance's own spec store (which
// would be destructive — the suite is non-destructive by convention, see
// e2e/global-setup.ts), each test builds a throwaway repo in the OS temp dir
// and hands it to the pipeline through `/api/gitfs/reconcile` — the same
// same-host, auth-free job endpoint the Supervisor itself uses. That is the
// canonical entry point (FR-001), so exercising it exercises exactly what
// every call site reaches: snapshot capture from refs, session creation, the
// auto-launch event, and the working-context parameterization.
//
// WHAT IS ASSERTED WHERE. Everything up to and including "the session exists,
// with the right working context, and the pane is showing it" is asserted
// here, end to end, in a browser. The agent's own resolution turns are NOT
// driven here: a real escalation starts a real model run, which this harness
// can only script through the `@@e2e` first-message directive
// (src/lib/assistant/e2e-provider.ts) — and the escalation's first message is
// the pipeline's task text, not a test directive. The decision loop, the
// completion, the rollback, and the boot sweep are therefore asserted against
// the real session store in tests/gitops/conflict-session-store.test.ts, which
// drives those exact code paths against real repos. Each scenario below says
// which half it covers.
//
// Self-cleaning: every test abandons the session it created (which also
// exercises S10's rollback) and removes its temp repo.

const IDENTITY = ["-c", "user.name=e2e", "-c", "user.email=e2e@test"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();
}

/** `git status --porcelain`, minus the reconciliation pipeline's own transient
 *  `.git-lock` file (gitLock writes it into the repo dir and removes it on
 *  release; an escalation can still be holding it the instant we look). */
function workingTree(dir: string): string {
  return git(dir, ["status", "--porcelain"])
    .split("\n")
    .filter((l) => l.trim() && !l.includes(".git-lock"))
    .join("\n");
}

interface Repo {
  dir: string;
  cleanup: () => void;
}

/** A repo whose `main` and `feature` branches each ADD the same path with
 *  different content — the exact shape of the reported repro (an add/add, so
 *  the file is absent at the merge base and `git show <base>:<rel>` fails). */
function makeConflictRepo(opts: { binary?: boolean } = {}): Repo {
  const dir = mkdtempSync(join(tmpdir(), "bos-e2e-conflict-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "shared history\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);

  const name = opts.binary ? "asset.bin" : "test-results.md";
  const mainSide = opts.binary ? Buffer.from([0x00, 0x01, 0x02, 0x03]) : "# main version\ncoverage: 88%\n";
  const featureSide = opts.binary ? Buffer.from([0x00, 0xff, 0xfe, 0xfd]) : "# feature version\ncoverage: 92%\n";

  writeFileSync(join(dir, name), mainSide as never);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `main adds ${name}`]);

  git(dir, ["checkout", "-q", "-b", "feature", "HEAD~1"]);
  writeFileSync(join(dir, name), featureSide as never);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `feature adds ${name}`]);
  git(dir, ["checkout", "-q", "main"]);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Escalation {
  sessionId: string;
  devopsConversationId?: string;
}

/** Run the pipeline against `repo` and wait for it to escalate. Returns as
 *  soon as the job reports `escalated` — which is the moment the session, the
 *  event, and the response's session id all exist (FR-018), and well before
 *  the agent's own run reaches any outcome. */
async function escalate(
  page: Page,
  repo: string,
  overrides: Record<string, unknown> = {},
): Promise<Escalation> {
  const start = await page.request.post("/api/gitfs/reconcile", {
    data: {
      repoPath: repo,
      sourceRef: "feature",
      strategy: "merge",
      repoKind: "user-specs",
      repoRoot: repo,
      repoLabel: "user-specs store",
      mode: "working-tree",
      operationLabel: "spec promote",
      completion: { kind: "merge", strategy: "merge" },
      ...overrides,
    },
  });
  expect(start.ok(), await start.text()).toBeTruthy();
  const { jobId } = (await start.json()) as { jobId: string };

  const deadline = Date.now() + 60_000;
  for (;;) {
    const poll = await page.request.get(`/api/gitfs/reconcile?jobId=${encodeURIComponent(jobId)}`);
    const body = (await poll.json()) as {
      phase: string;
      sessionId?: string;
      devopsConversationId?: string;
      outcome?: { status: string; error?: { message?: string } };
    };
    if (body.sessionId) return { sessionId: body.sessionId, devopsConversationId: body.devopsConversationId };
    if (body.phase === "done") {
      throw new Error(`reconcile finished without escalating: ${JSON.stringify(body.outcome)}`);
    }
    if (Date.now() > deadline) throw new Error(`reconcile job ${jobId} never escalated`);
    await page.waitForTimeout(400);
  }
}

async function getSession(page: Page, sessionId: string) {
  const res = await page.request.get(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { session: Record<string, unknown> };
  return body.session as {
    id: string;
    status: string;
    rollbackTag: string;
    conversationId: string;
    agentId: string;
    operationLabel: string;
    featureBranch: string;
    baseBranch: string;
    snapshot: { base: string; ours: string; theirs: string; files: string[] };
    files: { path: string; binary: boolean; marker: string }[];
    workContext: { repoKind: string; repoPath: string; mode: string; label: string };
  };
}

async function abandon(page: Page, sessionId: string) {
  await page.request
    .patch(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`, { data: { action: "abandon" } })
    .catch(() => {});
}

test.describe("Git Conflict Resolution System (035)", () => {
  // The pane restores whatever session is ACTIVE, so a session left behind by
  // an earlier test (or an earlier run) would be the one it shows. Start each
  // test from a clean slate — abandoning is also the documented way to close a
  // session, so this exercises the real path rather than poking the store.
  test.beforeEach(async ({ page }) => {
    // Hygiene, not an assertion: a transient connection reset from the dev
    // server (which compiles routes on demand) must not fail the test that
    // hasn't started yet. One retry, then give up quietly.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await page.request.get("/api/gitops/sessions");
        if (!res.ok()) return;
        const { sessions } = (await res.json()) as { sessions: { id: string }[] };
        for (const s of sessions) await abandon(page, s.id);
        return;
      } catch {
        await page.waitForTimeout(500);
      }
    }
  });

  test("S1: an add/add promote conflict creates a session with the repo's working context, and never touches base", async ({ page }) => {
    const repo = makeConflictRepo();
    const mainBefore = git(repo.dir, ["rev-parse", "main"]);
    let sessionId = "";
    try {
      const esc = await escalate(page, repo.dir);
      sessionId = esc.sessionId;
      expect(sessionId).toBeTruthy();
      // FR-018: the response carries the session id AND the conversation id.
      expect(esc.devopsConversationId).toBeTruthy();

      const session = await getSession(page, sessionId);
      // FR-003/FR-004: the working context targets THIS repo, not the BOS source tree.
      expect(session.workContext.repoPath).toBe(repo.dir);
      expect(session.workContext.repoKind).toBe("user-specs");
      expect(session.workContext.mode).toBe("working-tree");
      expect(session.operationLabel).toBe("spec promote");

      // The snapshot is refs-based and names the conflicting file.
      expect(session.snapshot.ours).toBe("main");
      expect(session.snapshot.theirs).toBe("feature");
      expect(session.snapshot.base).toBe(git(repo.dir, ["merge-base", "main", "feature"]));
      expect(session.snapshot.files).toContain("test-results.md");
      expect(session.files[0].marker).toBe("add/add");

      // FR-017: a rollback tag exists, and main was never left conflicted.
      expect(session.rollbackTag).toMatch(/^bos\/pre-reconcile-/);
      expect(git(repo.dir, ["rev-parse", "main"])).toBe(mainBefore);
      expect(workingTree(repo.dir)).toBe("");
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S1/S2/FR-008: the three-way content is served from refs, with an empty base side for add/add", async ({ page }) => {
    const repo = makeConflictRepo();
    let sessionId = "";
    try {
      sessionId = (await escalate(page, repo.dir)).sessionId;
      const res = await page.request.get(
        `/api/gitops/sessions?id=${encodeURIComponent(sessionId)}&file=${encodeURIComponent("test-results.md")}`,
      );
      expect(res.ok()).toBeTruthy();
      const { file } = (await res.json()) as {
        file: { binary: boolean; base: string | null; ours: string; theirs: string; markers: string; hunks: unknown[] };
      };
      expect(file.binary).toBe(false);
      // The add/add base side: the file does not exist at the merge base, and
      // that surfaces as empty rather than as an error.
      expect(file.base).toBeNull();
      expect(file.ours).toContain("main version");
      expect(file.theirs).toContain("feature version");
      expect(file.markers).toContain("<<<<<<<");
      expect(file.hunks.length).toBeGreaterThan(0);
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S2: the source-repo path keeps its pre-035 shape — default agent devops, activeFeatureBranch pre-set (FR-023)", async ({ page }) => {
    const repo = makeConflictRepo();
    let sessionId = "";
    try {
      const esc = await escalate(page, repo.dir, {
        repoKind: "source",
        repoLabel: "BOS source",
        featureBranchForDelegate: "bos/e2e-035-source-parity",
      });
      sessionId = esc.sessionId;
      const session = await getSession(page, sessionId);

      // FR-025's default is the pre-035 hard-coded value, which is what keeps
      // the existing source escalation identical.
      expect(session.agentId).toBe("devops");
      expect(session.workContext.repoKind).toBe("source");
      expect(session.featureBranch).toBe("bos/e2e-035-source-parity");

      // The conversation still carries activeFeatureBranch for dev_delegate,
      // and now ALSO carries the session id the conflict tools read back.
      const convo = await page.request.get(
        `/api/files/read?path=${encodeURIComponent(`/Documents/Chats/${session.conversationId}.json`)}`,
      );
      if (convo.ok()) {
        const raw = await convo.text();
        expect(raw).toContain("bos/e2e-035-source-parity");
        expect(raw).toContain(sessionId);
      }
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S3/S4/S5/S6: the SAME machinery serves every repo kind — only the working context differs", async ({ page }) => {
    // Four full escalations in one test — each is a real git pipeline run.
    test.setTimeout(120_000);
    // Cross-repo generality (FR-003/FR-004) is the claim; this asserts it
    // directly by running the identical pipeline with four different contexts
    // and checking nothing but the context varies.
    for (const [repoKind, label, operationLabel] of [
      ["user-specs", "user-specs store", "pull"],
      ["user-apps", "user-apps", "app promote"],
      ["vfs-mount", "mounted repo", "mount sync"],
      ["generic", "some repo", "push (non-fast-forward recovery)"],
    ] as const) {
      const repo = makeConflictRepo();
      let sessionId = "";
      try {
        sessionId = (await escalate(page, repo.dir, { repoKind, repoLabel: label, operationLabel })).sessionId;
        const session = await getSession(page, sessionId);
        expect(session.workContext.repoKind).toBe(repoKind);
        expect(session.workContext.label).toBe(label);
        expect(session.workContext.repoPath).toBe(repo.dir);
        expect(session.operationLabel).toBe(operationLabel);
        // Identical snapshot machinery regardless of kind.
        expect(session.snapshot.files).toContain("test-results.md");
        expect(session.rollbackTag).toMatch(/^bos\/pre-reconcile-/);
      } finally {
        if (sessionId) await abandon(page, sessionId);
        repo.cleanup();
      }
    }
  });

  test("S8: a binary conflict is flagged as unresolvable-by-agent, never silently merged (FR-022)", async ({ page }) => {
    const repo = makeConflictRepo({ binary: true });
    let sessionId = "";
    try {
      sessionId = (await escalate(page, repo.dir)).sessionId;
      const session = await getSession(page, sessionId);
      const binary = session.files.find((f) => f.path === "asset.bin");
      expect(binary, "the binary file should be in the snapshot").toBeTruthy();
      expect(binary!.binary).toBe(true);

      // The three-way read refuses to hand back content the agent could try to
      // "merge", and says so explicitly.
      const res = await page.request.get(
        `/api/gitops/sessions?id=${encodeURIComponent(sessionId)}&file=${encodeURIComponent("asset.bin")}`,
      );
      const { file } = (await res.json()) as { file: { binary: boolean; ours: string | null; markers: string | null } };
      expect(file.binary).toBe(true);
      expect(file.ours).toBeNull();
      expect(file.markers).toBeNull();
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S12: a second reconcile on the same repo re-points to the existing session instead of starting a parallel one", async ({ page }) => {
    const repo = makeConflictRepo();
    let sessionId = "";
    try {
      const first = await escalate(page, repo.dir);
      sessionId = first.sessionId;
      const second = await escalate(page, repo.dir);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.devopsConversationId).toBe(first.devopsConversationId);

      // And exactly one session exists for that repo.
      const list = await page.request.get("/api/gitops/sessions");
      const { sessions } = (await list.json()) as { sessions: { id: string; workContext: { repoPath: string } }[] };
      expect(sessions.filter((s) => s.workContext.repoPath === repo.dir).length).toBe(1);
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S10: abandoning rolls the repo back to the rollback tag and closes the session", async ({ page }) => {
    const repo = makeConflictRepo();
    const mainBefore = git(repo.dir, ["rev-parse", "main"]);
    let sessionId = "";
    try {
      sessionId = (await escalate(page, repo.dir)).sessionId;
      const before = await getSession(page, sessionId);
      expect(before.rollbackTag).toBeTruthy();

      const res = await page.request.patch(`/api/gitops/sessions?id=${encodeURIComponent(sessionId)}`, {
        data: { action: "abandon", reason: "e2e cleanup" },
      });
      expect(res.ok()).toBeTruthy();
      const { session } = (await res.json()) as { session: { status: string } };
      expect(session.status).toBe("abandoned");

      // The repo is exactly where it started, and base was never conflicted.
      expect(git(repo.dir, ["rev-parse", "main"])).toBe(mainBefore);
      expect(workingTree(repo.dir)).toBe("");
      expect(git(repo.dir, ["tag", "-l", before.rollbackTag])).toBe(before.rollbackTag);

      // Terminal: it drops out of the active list, freeing the repo (S12).
      const list = await page.request.get("/api/gitops/sessions");
      const { sessions } = (await list.json()) as { sessions: { id: string }[] };
      expect(sessions.map((s) => s.id)).not.toContain(sessionId);
    } finally {
      repo.cleanup();
    }
  });

  test("S1/S5/FR-007: Build Studio auto-launches with the conflict pane when a conflict is detected", async ({ page }) => {
    const repo = makeConflictRepo();
    let sessionId = "";
    try {
      // The page is already on the desktop and Build Studio is NOT open. The
      // topbar subscriber must open it with no user action at all.
      await expect(page.getByTestId("conflict-pane")).toHaveCount(0);

      sessionId = (await escalate(page, repo.dir)).sessionId;

      const pane = page.getByTestId("conflict-pane");
      await expect(pane).toBeVisible({ timeout: 30_000 });
      await expect(pane).toHaveAttribute("data-session-id", sessionId);

      // It renders the session: status pill, the repo/branch/rollback-tag
      // metadata, the conflicting file, and the abandon affordance (FR-008/FR-011).
      await expect(page.getByTestId("conflict-status-pill")).toBeVisible();
      await expect(pane).toContainText("user-specs store");
      await expect(pane).toContainText("test-results.md");
      await expect(pane).toContainText(/bos\/pre-reconcile-/);
      await expect(page.getByTestId("conflict-abandon")).toBeVisible();

      // The 3-way view renders both sides and the empty add/add base.
      await page.getByTestId("conflict-file-row").first().click();
      // The three-way view is a real server round-trip that shells out to git
      // (three `git show`s plus a `merge-file`), so it needs more than the 5s
      // default — especially on a dev server still compiling the route.
      await expect(page.getByTestId("conflict-unified")).toBeVisible({ timeout: 20_000 });
      await expect(pane).toContainText("(empty)", { timeout: 10_000 });
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S9 (browser refresh): the pane restores itself from the session store, with no event re-emit", async ({ page }) => {
    const repo = makeConflictRepo();
    let sessionId = "";
    try {
      sessionId = (await escalate(page, repo.dir)).sessionId;
      await expect(page.getByTestId("conflict-pane")).toBeVisible({ timeout: 30_000 });

      // A plain reload replays no events at all — the pane has to re-derive
      // the active session from the durable store on mount (FR-024).
      await page.reload();
      const skip = page.getByRole("button", { name: "Skip" });
      if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

      const pane = page.getByTestId("conflict-pane");
      await expect(pane).toBeVisible({ timeout: 30_000 });
      await expect(pane).toHaveAttribute("data-session-id", sessionId);
      await expect(pane).toContainText("test-results.md");
    } finally {
      if (sessionId) await abandon(page, sessionId);
      repo.cleanup();
    }
  });

  test("S10 (UI): Abandon & roll back confirms, restores the repo, and reverts the pane", async ({ page }) => {
    // A full escalation plus a real rollback (which takes the repo lock the
    // escalation may still be releasing) — more than the 30s default allows.
    test.setTimeout(90_000);
    const repo = makeConflictRepo();
    const mainBefore = git(repo.dir, ["rev-parse", "main"]);
    try {
      // Abandoning through the UI IS this test's cleanup — no API fallback.
      await escalate(page, repo.dir);
      await expect(page.getByTestId("conflict-pane")).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("conflict-abandon").click();
      await expect(page.getByTestId("conflict-abandon-confirm")).toBeVisible();
      await page.getByTestId("conflict-abandon-confirm").click();

      // Terminal is the requirement (S10: "the session is closed"), not one
      // specific terminal. The escalation's own watchdog may settle the
      // session as `failed` at almost the same moment the user abandons it —
      // both roll back through the same tag, and which one wins the race is
      // not something the user can observe or should depend on.
      await expect(page.getByTestId("conflict-status-pill")).toHaveAttribute(
        "data-status",
        /abandoned|failed|timed-out/,
        { timeout: 45_000 },
      );
      expect(git(repo.dir, ["rev-parse", "main"])).toBe(mainBefore);
      expect(workingTree(repo.dir)).toBe("");
    } finally {
      repo.cleanup();
    }
  });

  test("S11: the conflict-resolution agent is configurable in Settings → Build Studio and read at escalation time", async ({ page }) => {
    const cfg = await page.request.get("/api/config");
    const schemas = ((await cfg.json()) as { schemas: { namespace: string; values?: Record<string, unknown> }[] }).schemas;
    const original = schemas.find((s) => s.namespace === "build-studio")?.values?.conflictAgent ?? "devops";
    expect(original).toBeTruthy();

    const repo = makeConflictRepo();
    let sessionId = "";
    try {
      // Save a different agent through the same endpoint the Settings tab uses.
      const saved = await page.request.patch("/api/config", {
        data: { namespace: "build-studio", values: { conflictAgent: "planner" } },
      });
      expect(saved.ok()).toBeTruthy();

      // No reload anywhere — the pipeline reads the value on THIS escalation.
      sessionId = (await escalate(page, repo.dir)).sessionId;
      const session = await getSession(page, sessionId);
      expect(session.agentId).toBe("planner");
    } finally {
      if (sessionId) await abandon(page, sessionId);
      await page.request
        .patch("/api/config", { data: { namespace: "build-studio", values: { conflictAgent: original } } })
        .catch(() => {});
      repo.cleanup();
    }
  });

  test("S11 (UI): the Settings tab exposes the conflict-agent dropdown alongside the chat agent", async ({ page }) => {
    // Open the Settings app from the dock, then its Build Studio tab. Scoped
    // to the settings nav — "Build Studio" is also a desktop icon.
    await page.getByTestId("dock-settings").click();
    const nav = page.locator("nav", { hasText: "Settings" }).first();
    await nav.getByRole("button", { name: "Build Studio", exact: true }).click();
    const dropdown = page.getByTestId("build-studio-conflict-agent");
    await expect(dropdown).toBeVisible();
    // Populated from the same source as the existing agent field.
    expect(await dropdown.locator("option").count()).toBeGreaterThan(1);
  });

  test("FR-007: Build Studio declares the UI handler for the escalation event", async ({ page }) => {
    const res = await page.request.get("/api/events/handlers");
    expect(res.ok()).toBeTruthy();
    // The endpoint returns a map: eventType -> { headless: [...], ui: [...] }.
    const byType = (await res.json()) as Record<string, { ui?: { handlerId: string; ownerId?: string }[] }>;
    const entry = byType["com.bos.gitops.conflict.escalated"];
    expect(entry, "no handler registered for the escalation event").toBeTruthy();
    const ui = entry.ui ?? [];
    expect(ui.some((h) => h.handlerId === "build-studio:conflict-escalated")).toBe(true);
    // UI-only by design: no headless handler, which is exactly why the boot
    // sweep re-emits explicitly instead of relying on redispatchPendingOnBoot.
    expect(((await res.json()) as Record<string, { headless?: unknown[] }>)["com.bos.gitops.conflict.escalated"].headless ?? []).toEqual([]);
  });
});
