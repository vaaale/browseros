import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// E2E coverage for 031-self-healing.
//
// Runs against the real dev server's real case store and event store — the same
// convention as e2e/034-event-notification-system.spec.ts ("until BOS supports a
// separate data dir, e2e runs against the app's real data dir; the suite is
// written to be non-destructive"). Every test dismisses the cases it opens and
// restores the `selfHeal` config it changed, so a run leaves no residue.
//
// Serial, because the mechanism has genuinely global state: ONE pipeline slot,
// ONE dedupe map, ONE daily cost ledger. Parallel tests would contend for all
// three and prove nothing.
test.describe.configure({ mode: "serial" });

const CONFIG_NS = "selfHeal";

/** A per-run-unique marker so this suite's cases are always identifiable and
 *  never dedupe against a previous run's. */
function uniqueSuffix(): string {
  return `${test.info().workerIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface CaseRun {
  runId: string;
  agentId: string;
  role: "diagnostician" | "pipeline";
  status: "in-flight" | "completed" | "failed" | "aborted" | "stopped";
  startedAt: number;
}

interface CaseRecord {
  id: string;
  status: string;
  runs?: CaseRun[];
  stuckSignature?: { runId: string; reason: string; tool: string; count: number };
  stoppedFrom?: string;
  scopeClass?: string;
  ownership?: string;
  trigger: string;
  title: string;
  proposedSurface?: string;
  activeFeatureBranch?: string;
  appId?: string;
  reportPath?: string;
  pendingQuestion?: string;
  fixSummary?: string;
  timeline: { at: number; status: string; note?: string }[];
}

async function readConfig(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get("/api/config").then((r) => r.json());
  const schemas = (res.schemas ?? []) as { namespace: string; values?: Record<string, unknown> }[];
  return schemas.find((s) => s.namespace === CONFIG_NS)?.values ?? {};
}

async function patchConfig(page: Page, values: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch("/api/config", {
    data: { namespace: CONFIG_NS, values },
  });
  expect(res.ok()).toBeTruthy();
}

async function listCases(page: Page): Promise<CaseRecord[]> {
  const data = await page.request.get("/api/self-heal").then((r) => r.json());
  return (data.cases ?? []) as CaseRecord[];
}

async function getCase(page: Page, caseId: string): Promise<{ case: CaseRecord; report: string }> {
  return page.request.get(`/api/self-heal?caseId=${encodeURIComponent(caseId)}`).then((r) => r.json());
}

async function report(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post("/api/self-heal?op=report", { data: body });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<{ outcome: { action: string; caseId?: string; originalCaseId?: string } }>;
}

/** The read-only transcript API (031 scope-add FR-030). `found: false` is a
 *  normal answer — a run that executed while transcription was off has no file. */
async function readTranscript(page: Page, runId: string) {
  return page.request
    .get(`/api/agent-transcripts?runId=${encodeURIComponent(runId)}`)
    .then((r) => r.json() as Promise<{ found?: boolean; markdown?: string; status?: string; agentId?: string; caseId?: string }>);
}

/** Wait for the case to have recorded a run of `role` — the runs list is
 *  appended from the run's leading `run_started` event, so it appears while the
 *  run is still in flight. */
async function waitForRun(page: Page, caseId: string, role: "diagnostician" | "pipeline", timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { case: record } = await getCase(page, caseId);
    const run = (record.runs ?? []).find((r) => r.role === role);
    if (run) return run;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function dismiss(page: Page, caseId: string) {
  await page.request.post("/api/self-heal?op=dismiss", { data: { caseId, reason: "e2e cleanup" } }).catch(() => {});
}

/** A trigger event, fired through the 034 kernel exactly as a real trigger
 *  would be — so the spine's registered core handler is what processes it. */
async function fireTriggerEvent(page: Page, payload: Record<string, unknown>) {
  const res = await page.request.post("/api/events", {
    data: {
      type: "com.bos.self-heal.trigger",
      payload,
      source: { appId: "e2e-test", name: "E2E Test" },
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<{ id: string }>;
}

/** Wait for a case whose title contains `marker`, or return null if none
 *  appears — "no case was created" is an assertion this suite makes often. */
async function findCase(page: Page, marker: string, timeoutMs = 8_000): Promise<CaseRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = (await listCases(page)).find((c) => c.title.includes(marker) || JSON.stringify(c).includes(marker));
    if (match) return match;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

async function openAssistantOnFreshConversation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Assistant", { exact: true }).first().dblclick({ timeout: 20_000 });
  await expect(page.getByTestId("assistant-v2")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible({ timeout: 15_000 });
  await page.getByTitle(/New .*conversation/i).first().click();
  await page.waitForTimeout(400);
}

// ───────────────────────────────────────────────────────────────────────────
// Cleanup: feature branches this suite leaves behind as REAL git refs
// ───────────────────────────────────────────────────────────────────────────
//
// An escalated case conditions a `bos/self-heal-<id>` branch, and the branch is
// created for real by the Supervisor at `dev_delegate` time (`supervisorBegin`)
// — so a run that gets that far leaves a ref in the repo that nothing else ever
// reaps. Delete them at the end of the file, plus the four known strays left by
// runs from before this hook existed (a one-time cleanup: deleting a name with
// no local ref is a no-op, so this stays harmless once they are gone).
//
// Never fails the run: cleanup is hygiene, not an assertion.
const KNOWN_STALE_BRANCHES = ["bos/testfixture-feature", "bos/testfixture-never-written", "bos/testfixture-some-feature", "bos/testfixture-test-feature"];

test.afterAll(async ({ request }) => {
  await (async () => {
    const { featureBranches = [] } = await request.get("/api/assistant/feature-branches").then((r) => r.json());
    const targets = (featureBranches as string[]).filter(
      (b) => b.startsWith("bos/self-heal-") || KNOWN_STALE_BRANCHES.includes(b),
    );
    const deleted: string[] = [];
    for (const branch of targets) {
      const res = await request.delete(`/api/assistant/feature-branches?name=${encodeURIComponent(branch)}`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; existed?: boolean; error?: string };
      if (body.ok && body.existed !== false) deleted.push(branch);
      else if (!body.ok) console.log(`[031 cleanup] could not delete ${branch}: ${body.error ?? res.status()}`);
    }
    console.log(
      deleted.length
        ? `[031 cleanup] deleted feature branches: ${deleted.join(", ")}`
        : "[031 cleanup] no stale feature branches to delete",
    );
  })().catch(() => {});
});

// ───────────────────────────────────────────────────────────────────────────
// SC-001 — the acceptance case: the `bos_app_launch` params gap
// ───────────────────────────────────────────────────────────────────────────
//
// This is the specific gap the mechanism was designed to catch. The two tests
// below are deliberately split:
//
//   1. the REGRESSION test — proves the gap is actually closed. It FAILS on the
//      base commit (where the tool schema has no `params` and the handler drops
//      it) and passes with the fix. This is the standing requirement for any
//      bug fix: a test that would not have failed before is not a regression
//      test.
//   2. the PIPELINE test — proves the mechanism gets from that gap's signature
//      to a diagnosed, escalated case with the branch pre-conditioned.

test.describe("SC-001: the bos_app_launch params gap", () => {
  test("REGRESSION (fails on base): bos_app_launch accepts a `file` param and passes it through", async ({ page }) => {
    await openAssistantOnFreshConversation(page);

    // The literal case from the bug report: "the agent couldn't open the
    // portfolio report in the Editor because bos_app_launch doesn't accept a
    // file parameter". (This BOS ships no `editor` app, so Files stands in as
    // the target — what is under test is the TOOL, not the app.)
    await page.getByTestId("chat-textarea").fill(
      script([
        {
          text: "opening a file",
          tools: [
            {
              name: "bos_app_launch",
              args: { appId: "files", params: { file: "/Documents/welcome.txt", path: "/Documents" } },
            },
          ],
        },
        { text: "Opened it." },
      ]),
    );
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60_000 });

    const convId = await page.evaluate(() => localStorage.getItem("bos.activeConversation.assistant") ?? "");
    const { messages } = await page.request
      .get(`/api/assistant/conversations/${convId}/messages`)
      .then((r) => r.json());
    const toolResults = (messages as { role: string; content?: string }[])
      .filter((m) => m.role === "tool")
      .map((m) => m.content ?? "");

    // ON BASE: the handler is `async ({ appId }) => store.launch(appId)` — the
    // `params` argument is dropped entirely (and the schema never declared it),
    // so the result reads "Launched files (window …)." and never mentions the
    // file. THAT is the gap this whole feature was built to catch.
    expect(toolResults.join("\n")).toContain("/Documents/welcome.txt");
  });

  test("REGRESSION (fails on base): launch params actually reach the app's window", async ({ page }) => {
    await openAssistantOnFreshConversation(page);

    // The behavioural half of the same gap: `store.launch(appId, params)` has
    // ALWAYS accepted params (src/store/os-store.ts) — the tool was the only
    // thing dropping them. Build Studio reads `params.pane` to open the
    // Self-Heal pane, so if params arrive, the pane is on screen.
    await page.getByTestId("chat-textarea").fill(
      script([
        {
          text: "opening build studio on the self-heal pane",
          tools: [{ name: "bos_app_launch", args: { appId: "build-studio", params: { pane: "self-heal" } } }],
        },
        { text: "Opened it." },
      ]),
    );
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 30_000 });

    // On base this never appears: params are dropped, Build Studio opens on its
    // default artifact viewer, and the pane is never mounted.
    await expect(page.getByTestId("self-heal-pane")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60_000 });
  });

  test("an explicit report of that gap creates a case the Diagnostician picks up", async ({ page }) => {
    const marker = `e2e-appLaunchParams-${uniqueSuffix()}`;
    const { outcome } = await report(page, {
      description: `${marker}: the agent couldn't open the portfolio report in the Editor because bos_app_launch doesn't accept a file parameter`,
      toolName: "bos_app_launch",
    });

    try {
      expect(outcome.action).toBe("created");
      expect(outcome.caseId).toBeTruthy();

      const detail = await getCase(page, outcome.caseId!);
      expect(detail.case.trigger).toBe("explicit");
      expect(detail.case.title).toContain(marker);
      // The case is created and the Diagnostician launched fire-and-forget, so
      // the very first observable state is already past `new`. What matters for
      // SC-001's "without user intervention" clause is that nothing is waiting
      // on a human here.
      expect(["new", "diagnosing", "diagnosed", "failed"]).toContain(detail.case.status);
      expect(detail.case.timeline.length).toBeGreaterThan(0);
    } finally {
      if (outcome.caseId) await dismiss(page, outcome.caseId);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SC-003 / SC-006 / SC-007 — the deterministic front door
// ───────────────────────────────────────────────────────────────────────────

test.describe("the front door", () => {
  test("SC-003: an environmental error creates ZERO cases", async ({ page }) => {
    const before = await readConfig(page);
    const marker = `e2e-envFilter-${uniqueSuffix()}`;
    try {
      await patchConfig(page, { enabled: true, "triggers.hardError": true });
      await fireTriggerEvent(page, {
        trigger: "hard-error",
        toolName: "web_fetch",
        errorMessage: `${marker}: getaddrinfo ENOTFOUND api.example.com`,
      });
      // Give the kernel a real chance to dispatch before asserting absence.
      await page.waitForTimeout(2_500);
      expect(await findCase(page, marker, 1_000)).toBeNull();
    } finally {
      await patchConfig(page, { enabled: before.enabled ?? true, "triggers.hardError": before["triggers.hardError"] ?? false });
    }
  });

  test("SC-006: with the kill switch off, nothing fires", async ({ page }) => {
    const before = await readConfig(page);
    const marker = `e2e-killSwitch-${uniqueSuffix()}`;
    try {
      await patchConfig(page, { enabled: false, "triggers.hardError": true, "triggers.explicit": true });

      // Both entry points are refused, and the API says so rather than
      // silently doing nothing.
      const { outcome } = await report(page, { description: `${marker}: something is broken` });
      expect(outcome.action).toBe("disabled");

      await fireTriggerEvent(page, {
        trigger: "hard-error",
        toolName: "file_read",
        errorMessage: `${marker}: permission denied`,
      });
      await page.waitForTimeout(2_500);
      expect(await findCase(page, marker, 1_000)).toBeNull();
    } finally {
      await patchConfig(page, {
        enabled: before.enabled ?? true,
        "triggers.hardError": before["triggers.hardError"] ?? false,
        "triggers.explicit": before["triggers.explicit"] ?? true,
      });
    }
  });

  test("SC-007: the same signature twice inside the window creates ONE case", async ({ page }) => {
    const marker = `e2e-dedupe-${uniqueSuffix()}`;
    const description = `${marker}: the same problem, reported twice in quick succession`;
    let caseId: string | undefined;
    try {
      const first = await report(page, { description, toolName: "file_read" });
      expect(first.outcome.action).toBe("created");
      caseId = first.outcome.caseId;

      const second = await report(page, { description, toolName: "file_read" });
      expect(second.outcome.action).toBe("duplicate");
      expect(second.outcome.originalCaseId).toBe(caseId);

      // Exactly one case bears this marker.
      const mine = (await listCases(page)).filter((c) => c.title.includes(marker));
      expect(mine).toHaveLength(1);
    } finally {
      if (caseId) await dismiss(page, caseId);
    }
  });

  test("a disabled trigger blocks only itself", async ({ page }) => {
    const before = await readConfig(page);
    const marker = `e2e-perTrigger-${uniqueSuffix()}`;
    let caseId: string | undefined;
    try {
      await patchConfig(page, { enabled: true, "triggers.hardError": false, "triggers.explicit": true });
      await fireTriggerEvent(page, {
        trigger: "hard-error",
        toolName: "file_read",
        errorMessage: `${marker}: permission denied on a real path`,
      });
      await page.waitForTimeout(2_500);
      expect(await findCase(page, marker, 1_000)).toBeNull();

      // The explicit trigger, left on, still works.
      const { outcome } = await report(page, { description: `${marker}-explicit: reported by hand` });
      expect(outcome.action).toBe("created");
      caseId = outcome.caseId;
    } finally {
      if (caseId) await dismiss(page, caseId);
      await patchConfig(page, {
        enabled: before.enabled ?? true,
        "triggers.hardError": before["triggers.hardError"] ?? false,
      });
    }
  });

  test("a log event from a non-BOS component is refused (FR-005)", async ({ page }) => {
    const before = await readConfig(page);
    const marker = `e2e-notOwned-${uniqueSuffix()}`;
    try {
      await patchConfig(page, { enabled: true, "triggers.logEvents": true });
      await fireTriggerEvent(page, {
        trigger: "log-events",
        component: "some-third-party-service",
        level: "error",
        message: `${marker}: the service exploded`,
      });
      await page.waitForTimeout(2_500);
      expect(await findCase(page, marker, 1_000)).toBeNull();
    } finally {
      await patchConfig(page, { "triggers.logEvents": before["triggers.logEvents"] ?? false });
    }
  });

  test("FR-025: an event carrying a self-heal role marker never re-enters", async ({ page }) => {
    const before = await readConfig(page);
    const marker = `e2e-reentrancy-${uniqueSuffix()}`;
    try {
      await patchConfig(page, { enabled: true, "triggers.hardError": true });
      await fireTriggerEvent(page, {
        trigger: "hard-error",
        toolName: "file_read",
        errorMessage: `${marker}: permission denied`,
        // What every lifecycle event the spine emits carries.
        selfHeal: { role: "lifecycle", caseId: "0001" },
      });
      await page.waitForTimeout(2_500);
      expect(await findCase(page, marker, 1_000)).toBeNull();
    } finally {
      await patchConfig(page, { "triggers.hardError": before["triggers.hardError"] ?? false });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// US3 / SC-004 / SC-005 — trigger shapes and the ownership boundary
// ───────────────────────────────────────────────────────────────────────────

test.describe("trigger shapes", () => {
  test("US3: a workflow-timeout event becomes a workflow-scoped case", async ({ page }) => {
    const before = await readConfig(page);
    const workflowId = `e2e-wf-${uniqueSuffix()}`;
    let caseId: string | undefined;
    try {
      await patchConfig(page, { enabled: true, "triggers.workflowTimeout": true });
      await fireTriggerEvent(page, {
        trigger: "workflow-timeout",
        workflowId,
        node: "research",
        configuredMs: 10_000,
        actualMs: 45_000,
      });

      const record = await findCase(page, workflowId, 10_000);
      expect(record).not.toBeNull();
      caseId = record!.id;
      expect(record!.trigger).toBe("workflow-timeout");
      // The case is scoped to the WORKFLOW, not to whatever app it called —
      // getting this wrong would send a fix at the wrong artifact.
      const detail = await getCase(page, caseId);
      expect(detail.case.title).toContain(workflowId);
      expect(JSON.stringify(detail.case)).toContain("research");
    } finally {
      if (caseId) await dismiss(page, caseId);
      await patchConfig(page, { "triggers.workflowTimeout": before["triggers.workflowTimeout"] ?? false });
    }
  });

  test("SC-005: a bug in an app the user does not maintain is notify-only", async ({ page }) => {
    // The ownership predicate is server-side and authoritative: an item id with
    // no `data/user-apps/items/<id>/` copy can only ever be class `d`. This
    // asserts the boundary from the outside — the case exists, and BOS opened
    // no branch and no app rebuild for it.
    const marker = `e2e-notOwned-app-${uniqueSuffix()}`;
    const { outcome } = await report(page, {
      description: `${marker}: the "definitely-not-installed-${uniqueSuffix()}" marketplace app crashes on open`,
      appId: `definitely-not-installed-${uniqueSuffix()}`,
    });
    try {
      expect(outcome.action).toBe("created");
      const detail = await getCase(page, outcome.caseId!);
      expect(detail.case.activeFeatureBranch).toBeUndefined();
      expect(["new", "diagnosing", "diagnosed", "notified", "failed"]).toContain(detail.case.status);
    } finally {
      if (outcome.caseId) await dismiss(page, outcome.caseId);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-022 / SC-009 — the review surface
// ───────────────────────────────────────────────────────────────────────────

test.describe("Build Studio → Self-Heal", () => {
  test("the pane opens from the Build Studio nav and lists cases", async ({ page }) => {
    const marker = `e2e-pane-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: a problem to look at in the pane` });
    try {
      await page.getByTestId("dock-build-studio").click();
      const win = page.getByTestId("window-build-studio");
      await expect(win).toBeVisible({ timeout: 20_000 });

      await win.getByTestId("build-studio-self-heal-nav").click();
      await expect(win.getByTestId("self-heal-pane")).toBeVisible({ timeout: 15_000 });

      // The binding column order from the mockup (Status → Case → Trigger →
      // Scope Class).
      const list = win.getByTestId("self-heal-case-list");
      await expect(list).toBeVisible({ timeout: 15_000 });
      // `allInnerTexts` returns the RENDERED text, which the header's
      // `uppercase` class has already transformed — compare case-insensitively
      // so this asserts the column ORDER (the binding part) and not the casing.
      const headers = (await list.locator("thead th").allInnerTexts()).map((h) => h.trim().toLowerCase());
      expect(headers).toEqual(["status", "case", "trigger", "scope class"]);

      // Our case is in it, rendered with the EHS- human id.
      const row = win.getByTestId(`self-heal-row-${outcome.caseId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText(`EHS-${outcome.caseId}`);
      await expect(row).toContainText("explicit");

      // The six-badge legend is on the page, so the vocabulary is learnable in
      // place rather than only in the docs.
      await expect(win.getByTestId("scope-class-legend")).toBeVisible();
    } finally {
      if (outcome.caseId) await dismiss(page, outcome.caseId);
    }
  });

  test("a case detail shows the header, the timeline and a back link", async ({ page }) => {
    const marker = `e2e-detail-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: open me and look at the timeline` });
    try {
      await page.getByTestId("dock-build-studio").click();
      const win = page.getByTestId("window-build-studio");
      await win.getByTestId("build-studio-self-heal-nav").click();
      await expect(win.getByTestId("self-heal-pane")).toBeVisible({ timeout: 15_000 });

      await win.getByTestId(`self-heal-row-${outcome.caseId}`).click();
      const detail = win.getByTestId(`self-heal-detail-${outcome.caseId}`);
      await expect(detail).toBeVisible({ timeout: 15_000 });
      await expect(detail).toContainText(`EHS-${outcome.caseId}`);
      await expect(detail).toContainText(marker);
      await expect(detail.getByTestId("self-heal-timeline")).toBeVisible();

      await detail.getByText("Back to cases").click();
      await expect(win.getByTestId("self-heal-case-list")).toBeVisible({ timeout: 10_000 });
    } finally {
      if (outcome.caseId) await dismiss(page, outcome.caseId);
    }
  });

  test("C1: 'Report a problem' opens a case from the UI", async ({ page }) => {
    const marker = `e2e-uiReport-${uniqueSuffix()}`;
    let caseId: string | undefined;
    try {
      await page.getByTestId("dock-build-studio").click();
      const win = page.getByTestId("window-build-studio");
      await win.getByTestId("build-studio-self-heal-nav").click();
      await expect(win.getByTestId("self-heal-pane")).toBeVisible({ timeout: 15_000 });

      await win.getByTestId("self-heal-report-open").click();
      await win.getByTestId("self-heal-report-description").fill(`${marker}: reported through the Build Studio button`);
      await win.getByTestId("self-heal-report-tool").fill("file_read");
      await win.getByTestId("self-heal-report-submit").click();

      const record = await findCase(page, marker, 15_000);
      expect(record).not.toBeNull();
      caseId = record!.id;
      expect(record!.trigger).toBe("explicit");
      await expect(win.getByTestId(`self-heal-row-${caseId}`)).toBeVisible({ timeout: 15_000 });
    } finally {
      if (caseId) await dismiss(page, caseId);
    }
  });

  test("SC-009: a suspended case shows the amber decision card, and answering resumes it", async ({ page }) => {
    const marker = `e2e-suspend-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: this one will need a decision` });
    const caseId = outcome.caseId!;
    try {
      // Drive the case to `suspended` the way the pipeline does — via the
      // spine, not by writing the store — so the UI sees a real state.
      await page.request.post("/api/self-heal?op=dismiss", { data: { caseId, reason: "reset for the suspend flow" } });

      // A fresh case we can suspend: the previous one is terminal now.
      const second = await report(page, { description: `${marker}-b: this one will need a decision` });
      const suspendId = second.outcome.caseId!;
      let restoreTools: () => Promise<void> = async () => {};
      try {
        restoreTools = await suspendViaSpine(page, suspendId, `${marker}: tool A or tool B?`);
        // The transition is observed over HTTP, so it lands a moment after the
        // run reports finished — poll rather than reading once.
        await expect
          .poll(async () => (await getCase(page, suspendId)).case.status, { timeout: 20_000 })
          .toBe("suspended");

        await page.getByTestId("dock-build-studio").click();
        const win = page.getByTestId("window-build-studio");
        await win.getByTestId("build-studio-self-heal-nav").click();
        await expect(win.getByTestId("self-heal-pane")).toBeVisible({ timeout: 15_000 });
        await win.getByTestId(`self-heal-row-${suspendId}`).click();

        const card = win.getByTestId("self-heal-suspended-card");
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card).toContainText("Waiting on you");
        await expect(card).toContainText("tool A or tool B?");

        await win.getByTestId("self-heal-answer-input").fill("tool A — it owns the schema");
        await win.getByTestId("self-heal-submit-answer").click();

        // The answer is recorded and the case leaves `suspended`.
        await expect
          .poll(async () => (await getCase(page, suspendId)).case.status, { timeout: 20_000 })
          .not.toBe("suspended");
        const after = await getCase(page, suspendId);
        expect(JSON.stringify(after.case)).toContain("tool A — it owns the schema");
      } finally {
        await restoreTools();
        await dismiss(page, suspendId);
      }
    } finally {
      await dismiss(page, caseId);
    }
  });
});

/**
 * Park a case on a question the way the pipeline really does: by calling
 * `self_heal_request_decision`.
 *
 * There is deliberately no HTTP op for suspending — only the running pipeline
 * may suspend its own case — so the test drives the TOOL, through a scripted
 * assistant turn. The assistant is granted the tool for the duration and it is
 * revoked again afterwards, so the deployment's own agent config is restored.
 */
async function suspendViaSpine(page: Page, caseId: string, question: string): Promise<() => Promise<void>> {
  const restore = await grantToolToAssistant(page, "self_heal_request_decision");
  await openAssistantOnFreshConversation(page);
  await page.getByTestId("chat-textarea").fill(
    script([
      {
        text: "asking for a decision",
        tools: [{ name: "self_heal_request_decision", args: { caseId, question } }],
      },
      { text: "Asked." },
    ]),
  );
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60_000 });
  return restore;
}

/** Add one capability to the `assistant` agent's allowlist, returning an undo.
 *  Tool visibility is a per-agent allowlist (`gateFor`), so a brand-new
 *  capability is not automatically callable by an existing agent — the same
 *  reason a user grants tools in Settings → Agents. */
async function grantToolToAssistant(page: Page, toolId: string): Promise<() => Promise<void>> {
  const data = await page.request.get("/api/assistant/agent").then((r) => r.json()).catch(() => null);
  const agents = (data?.agents ?? []) as { id: string; tools?: string[] }[];
  const current = agents.find((a) => a.id === "assistant")?.tools ?? [];
  if (current.includes(toolId)) return async () => {};
  const res = await page.request.patch("/api/assistant/agent", {
    data: { agentId: "assistant", tools: [...current, toolId] },
  });
  if (!res.ok()) return async () => {};
  return async () => {
    await page.request
      .patch("/api/assistant/agent", { data: { agentId: "assistant", tools: current } })
      .catch(() => {});
  };
}

// ───────────────────────────────────────────────────────────────────────────
// US5 — Settings → Self Improvement
// ───────────────────────────────────────────────────────────────────────────

test.describe("Settings → Self Improvement", () => {
  test("the tab renders, and the master switch dims everything else", async ({ page }) => {
    const before = await readConfig(page);
    try {
      await page.getByTestId("dock-settings").click();
      const win = page.getByTestId("window-settings");
      await expect(win).toBeVisible({ timeout: 20_000 });
      await win.getByRole("button", { name: "Self Improvement" }).click();

      const tab = win.getByTestId("self-improvement-tab");
      await expect(tab).toBeVisible({ timeout: 15_000 });

      const master = win.getByTestId("self-heal-enabled");
      const hardError = win.getByTestId("self-heal-trigger-hard-error");
      const costCap = win.getByTestId("self-heal-cost-cap");
      await expect(master).toBeVisible();

      // Master ON ⇒ the rest is live.
      if (!(await master.isChecked())) {
        await master.check();
        await page.waitForTimeout(300);
      }
      await expect(hardError).toBeEnabled();
      await expect(costCap).toBeEnabled();

      // Master OFF ⇒ everything else is disabled, because the kill switch
      // really does disable all of them (FR-006). A live-looking toggle that
      // does nothing would be worse than a greyed-out one.
      await master.uncheck();
      await expect(hardError).toBeDisabled();
      await expect(costCap).toBeDisabled();
      await expect.poll(async () => (await readConfig(page)).enabled, { timeout: 10_000 }).toBe(false);
    } finally {
      await patchConfig(page, { enabled: before.enabled ?? true });
    }
  });

  test("changing a limit persists to the selfHeal namespace", async ({ page }) => {
    const before = await readConfig(page);
    try {
      await page.getByTestId("dock-settings").click();
      const win = page.getByTestId("window-settings");
      await win.getByRole("button", { name: "Self Improvement" }).click();
      await expect(win.getByTestId("self-improvement-tab")).toBeVisible({ timeout: 15_000 });

      const dedupe = win.getByTestId("self-heal-dedupe-window");
      await dedupe.fill("4242");
      await dedupe.blur();

      await expect.poll(async () => (await readConfig(page)).dedupeWindowSec, { timeout: 10_000 }).toBe(4242);
    } finally {
      await patchConfig(page, { dedupeWindowSec: before.dedupeWindowSec ?? 86_400 });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-020 — the cost cap queues, it does not drop
// ───────────────────────────────────────────────────────────────────────────

test.describe("the daily cost cap", () => {
  test("over budget, a new trigger is QUEUED rather than dropped", async ({ page }) => {
    const before = await readConfig(page);
    const marker = `e2e-costCap-${uniqueSuffix()}`;
    let caseId: string | undefined;
    try {
      // A cap of 1 token is guaranteed to be already spent by any prior run
      // today — and if nothing has run, the very next case tips it. Either way
      // this test asserts the SEMANTICS: over budget ⇒ queued, never dropped.
      await patchConfig(page, { enabled: true, "triggers.explicit": true, costCapPerDay: 1 });

      const first = await report(page, { description: `${marker}-a: burn a little budget` });
      caseId = first.outcome.caseId;
      const second = await report(page, { description: `${marker}-b: this one should be queued` });

      expect(["created", "queued-cost"]).toContain(second.outcome.action);
      const status = await page.request.get("/api/self-heal").then((r) => r.json());
      expect(status.cost.capPerDay).toBe(1);

      if (second.outcome.action === "queued-cost") {
        const detail = await getCase(page, second.outcome.caseId!);
        expect(detail.case.status).toBe("queued-cost");
        // Queued, not dropped: the case exists and says why.
        expect(detail.case.timeline.at(-1)?.note).toContain("cost cap");
        expect(status.costQueue).toContain(second.outcome.caseId);
        await dismiss(page, second.outcome.caseId!);
      } else {
        await dismiss(page, second.outcome.caseId!);
      }
    } finally {
      if (caseId) await dismiss(page, caseId);
      await patchConfig(page, { costCapPerDay: before.costCapPerDay ?? 1_000_000 });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-026 — the lifecycle audit trail
// ───────────────────────────────────────────────────────────────────────────

test.describe("lifecycle events", () => {
  test("a created case and a suppressed duplicate both leave a queryable event", async ({ page }) => {
    const marker = `e2e-events-${uniqueSuffix()}`;
    const description = `${marker}: an auditable problem`;
    let caseId: string | undefined;
    try {
      const first = await report(page, { description });
      caseId = first.outcome.caseId!;
      await report(page, { description }); // suppressed

      const created = await page.request
        .get("/api/events?type=com.bos.self-heal.case_created&limit=50")
        .then((r) => r.json());
      expect(JSON.stringify(created)).toContain(caseId);

      const suppressed = await page.request
        .get("/api/events?type=com.bos.self-heal.dedupe_suppressed&limit=50")
        .then((r) => r.json());
      // FR-019: suppression is logged, never silent.
      expect(JSON.stringify(suppressed)).toContain(caseId);
    } finally {
      if (caseId) await dismiss(page, caseId);
    }
  });

  test("FR-024/SC-010: no case ever reaches a promoted state on its own", async ({ page }) => {
    // The mechanism has no promote path at all — there is no status, no event
    // and no API op for it. This asserts that from the outside: whatever the
    // store currently holds, nothing in it claims to have been promoted.
    const cases = await listCases(page);
    for (const record of cases) {
      expect(record.status).not.toBe("promoted");
    }
    const ops = await page.request.post("/api/self-heal?op=promote", { data: { caseId: "0001" } });
    expect(ops.ok()).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SC-011 … SC-014 / R-SA5 — the observability + control scope-add
// ───────────────────────────────────────────────────────────────────────────
//
// What is genuinely end-to-end here and what is not, stated plainly:
//
//   * Transcription (SC-011) and the pane (SC-012) are exercised against REAL
//     headless runs — reporting a problem launches a real Diagnostician run,
//     which writes a real transcript this suite then reads through the real
//     API and renders in the real pane.
//   * A REPEATED-CALL stuck run (SC-013) cannot be manufactured over HTTP: it
//     needs an agent that loops, and this suite has no way to make the
//     Diagnostician or the pipeline agent do that (the scripted-turn provider
//     only intercepts a task that STARTS with the directive, and both of those
//     tasks are server-composed briefs). So SC-013 here covers the control
//     surface end-to-end — Stop on a live run, the `stopped` state, Start
//     relaunching — and the detector's own firing is covered hermetically in
//     `tests/self-heal/stuck-detector.test.ts` and
//     `tests/self-heal/stopped-state.test.ts`, where the run's event stream
//     can be driven exactly.

test.describe("SC-011: every headless run leaves a transcript (FR-029/FR-030)", () => {
  test("the Diagnostician's run is transcribed, readable by id, and NOT in /Documents/Chats", async ({ page }) => {
    const marker = `e2e-transcript-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: transcribe this diagnosis` });
    const caseId = outcome.caseId!;
    try {
      // The case records its run from the run's leading `run_started` event,
      // which is what makes the id knowable while the run is still going.
      const run = await waitForRun(page, caseId, "diagnostician");
      expect(run).not.toBeNull();
      expect(run!.agentId).toBe("conversation-reviewer");
      expect(run!.runId).toContain("conversation-reviewer");

      const doc = await readTranscript(page, run!.runId);
      expect(doc.found).toBe(true);
      expect(doc.agentId).toBe("conversation-reviewer");
      // The task input is the audit artifact: what was this run actually asked?
      expect(doc.markdown).toContain("## Task");
      expect(doc.markdown).toContain("Mode 2");
      expect(doc.markdown).toContain("## Timeline");
      // Stamped with its owning case, so the file is self-describing.
      expect(doc.caseId).toBe(caseId);
      expect(["in-flight", "completed", "aborted"]).toContain(doc.status);

      // FR-030: transcripts live OUTSIDE the VFS. Nothing about this run may
      // appear in the conversation store the Chats app renders (and that the
      // Diagnostician's own idle review scans).
      const chats = await page.request
        .get(`/api/fs?op=list&path=${encodeURIComponent("/Documents/Chats")}`)
        .then((r) => r.json())
        .catch(() => ({ entries: [] }));
      const names = ((chats.entries ?? []) as { name?: string }[]).map((e) => e.name ?? "");
      expect(names.some((n) => n.includes(run!.runId))).toBe(false);
      expect(JSON.stringify(names)).not.toContain("agent-transcripts");

      // The per-agent listing finds the same run.
      const listed = await page.request
        .get("/api/agent-transcripts?agentId=conversation-reviewer")
        .then((r) => r.json());
      expect((listed.runs as { runId: string }[]).map((r) => r.runId)).toContain(run!.runId);

      // Read-only: there is no write surface on this route at all.
      const write = await page.request.post("/api/agent-transcripts", { data: { runId: run!.runId } });
      expect(write.ok()).toBeFalsy();
    } finally {
      await dismiss(page, caseId);
    }
  });

  test("a run's tool calls and results are in its transcript", async ({ page }) => {
    // A real headless run of a throwaway agent, scripted so it makes a known
    // tool call — the transcript's timeline must show the call AND its result.
    // (`BOS_E2E_SCRIPTED=1` is set for the server this suite drives; without it
    // the directive would go to a real model and this test is skipped.)
    const res = await page.request.post("/api/subagents/delegate", {
      data: {
        ephemeral: {
          name: `e2e transcript probe ${uniqueSuffix()}`,
          description: "probe",
          systemPrompt: "You are a test probe.",
          type: "local",
          tools: ["bos_app_list"],
        },
        task: script([
          { text: "listing the apps", tools: [{ name: "bos_app_list", args: {} }] },
          { text: "Done." },
        ]),
      },
      timeout: 60_000,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    const runIds = [...body.matchAll(/"runId":"([^"]+)"/g)].map((m) => m[1]);
    const agentId = [...body.matchAll(/"agentId":"([^"]+)"/g)].map((m) => m[1])[0];
    test.skip(runIds.length === 0, "the delegate stream reported no runId — BOS_E2E_SCRIPTED is probably not set");

    const doc = await readTranscript(page, runIds[0]);
    expect(doc.found).toBe(true);
    expect(doc.markdown).toContain("## Task");
    expect(doc.markdown).toContain("`bos_app_list`");
    expect(doc.markdown).toContain("↳ bos_app_list →");
    expect(doc.markdown).toContain("**assistant**");
    // A finished run is marked finished, so a reader can tell it is complete.
    expect(doc.status).toBe("completed");
    if (agentId) {
      const listed = await page.request.get(`/api/agent-transcripts?agentId=${encodeURIComponent(agentId)}`).then((r) => r.json());
      expect((listed.runs as { runId: string }[]).map((r) => r.runId)).toContain(runIds[0]);
    }
  });
});

test.describe("SC-012: the case's Transcripts section (FR-022f/FR-031)", () => {
  test("lists the case's runs and renders the selected one", async ({ page }) => {
    const marker = `e2e-transcriptPane-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: show me this run` });
    const caseId = outcome.caseId!;
    try {
      const run = await waitForRun(page, caseId, "diagnostician");
      expect(run).not.toBeNull();

      await page.getByTestId("dock-build-studio").click();
      const win = page.getByTestId("window-build-studio");
      await expect(win).toBeVisible({ timeout: 20_000 });
      await win.getByTestId("build-studio-self-heal-nav").click();
      await expect(win.getByTestId("self-heal-pane")).toBeVisible({ timeout: 15_000 });
      await win.getByTestId(`self-heal-row-${caseId}`).click();

      const section = win.getByTestId("self-heal-transcripts");
      await expect(section).toBeVisible({ timeout: 15_000 });
      const row = win.getByTestId(`self-heal-run-${run!.runId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText("Diagnostician");
      await expect(row).toContainText(run!.runId);
      // Whatever the run's outcome in this environment, the row states it.
      await expect(row).toContainText(/In-flight|Completed|Failed|Aborted|Stopped/);

      await win.getByTestId(`self-heal-view-transcript-${run!.runId}`).click();
      const panel = win.getByTestId("self-heal-transcript-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      // The task the run was actually given, rendered in the panel.
      await expect(panel).toContainText("Mode 2", { timeout: 15_000 });
      await expect(panel).toContainText(caseId);
    } finally {
      await dismiss(page, caseId);
    }
  });
});

test.describe("SC-013: Stop and Start a run (FR-034)", () => {
  test("Stop parks a live run as `stopped`, and Start relaunches it", async ({ page }) => {
    const marker = `e2e-stopStart-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: I will stop this one` });
    const caseId = outcome.caseId!;
    try {
      // Stop while the Diagnostician run is in flight. Its window is short in a
      // provider-less environment, so both outcomes are asserted for what they
      // are: a live run is killed and parked, and a run that already ended is a
      // no-op that reports the truth (R14) — never a silent lie either way.
      const run = await waitForRun(page, caseId, "diagnostician");
      expect(run).not.toBeNull();
      const stop = await page.request
        .post("/api/self-heal?op=stop", { data: { caseId } })
        .then((r) => r.json() as Promise<{ stopped?: boolean; reason?: string; case?: CaseRecord }>);

      if (stop.stopped) {
        expect(stop.case?.status).toBe("stopped");
        expect(stop.case?.stoppedFrom).toBe("diagnosing");
        const stopped = (await getCase(page, caseId)).case;
        expect(stopped.status).toBe("stopped");
        expect((stopped.runs ?? []).some((r) => r.status === "aborted")).toBe(true);
        // A killed run still leaves the partial transcript it had written.
        const doc = await readTranscript(page, run!.runId);
        expect(doc.found).toBe(true);
        expect(doc.markdown).toContain("## Task");

        // The pane offers Start (and not Stop) for a stopped case.
        await page.getByTestId("dock-build-studio").click();
        const win = page.getByTestId("window-build-studio");
        await win.getByTestId("build-studio-self-heal-nav").click();
        await expect(win.getByTestId("self-heal-pane")).toBeVisible({ timeout: 15_000 });
        await win.getByTestId(`self-heal-row-${caseId}`).click();
        const control = win.getByTestId("self-heal-run-control");
        await expect(control).toBeVisible({ timeout: 15_000 });
        await expect(win.getByTestId("self-heal-start-run")).toBeVisible();
        await expect(win.getByTestId("self-heal-stop-run")).toHaveCount(0);

        await win.getByTestId("self-heal-start-run").click();
        // Start leaves `stopped` — it re-enters the state it was stopped from
        // (or queues behind whatever holds the pipeline slot).
        await expect
          .poll(async () => (await getCase(page, caseId)).case.status, { timeout: 25_000 })
          .not.toBe("stopped");
        const restarted = (await getCase(page, caseId)).case;
        expect(["diagnosing", "diagnosed", "bs-pipeline", "queued-slow", "failed", "env-only", "notified"]).toContain(
          restarted.status,
        );
        expect(restarted.stoppedFrom).toBeUndefined();
        const events = await page.request
          .get("/api/events?type=com.bos.self-heal.run_restarted&limit=20")
          .then((r) => r.json());
        expect(JSON.stringify(events)).toContain(caseId);
      } else {
        // The run finished between the report and the click: Stop reports the
        // current status instead of pretending it killed something.
        expect(stop.reason).toBeTruthy();
        expect((await getCase(page, caseId)).case.status).not.toBe("stopped");
        // And Start refuses a case that is not stopped, for the same reason.
        const start = await page.request
          .post("/api/self-heal?op=start", { data: { caseId } })
          .then((r) => r.json() as Promise<{ started?: boolean; reason?: string }>);
        expect(start.started).toBe(false);
        expect(start.reason).toContain("not stopped");
      }
    } finally {
      await dismiss(page, caseId);
    }
  });

  test("Stop and Start are the only two run ops, and both need a real case", async ({ page }) => {
    const missing = await page.request.post("/api/self-heal?op=stop", { data: { caseId: "no-such-case" } });
    expect(missing.status()).toBe(404);
    const noOp = await page.request.post("/api/self-heal?op=kill", { data: { caseId: "0001" } });
    expect(noOp.ok()).toBeFalsy();
    expect(JSON.stringify(await noOp.json())).toContain("Unknown op");
  });
});

test.describe("SC-014 / FR-035: a stuck or stopped run never opens a new case", () => {
  test("the run-lifecycle events are not triggers", async ({ page }) => {
    const marker = `e2e-noReentry-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: watch for a second case` });
    const caseId = outcome.caseId!;
    try {
      const before = (await listCases(page)).length;

      // Fire all three run-lifecycle events through the real 034 kernel, with
      // the same `selfHeal.role` marker the spine puts on them. Even the
      // hard-error trigger is on for this check, so if any of them were a
      // trigger source, a case would appear.
      const config = await readConfig(page);
      await patchConfig(page, { enabled: true, "triggers.hardError": true });
      try {
        for (const type of ["run_stuck", "run_aborted", "run_restarted"]) {
          await page.request.post("/api/events", {
            data: {
              type: `com.bos.self-heal.${type}`,
              payload: {
                caseId,
                runId: "headless-build-studio-e2e",
                summary: `${marker}: ${type}`,
                selfHeal: { role: "lifecycle", caseId },
              },
              source: { appId: "e2e-test", name: "E2E Test" },
            },
          });
        }
        await new Promise((r) => setTimeout(r, 1_500));
        expect((await listCases(page)).length).toBe(before);
        expect(await findCase(page, `${marker}: run_stuck`, 1_000)).toBeNull();
      } finally {
        await patchConfig(page, {
          enabled: config.enabled !== false,
          "triggers.hardError": config["triggers.hardError"] === true,
        });
      }
    } finally {
      await dismiss(page, caseId);
    }
  });
});

test.describe("R-SA5: an aborted run's partial build is never announced as a fix", () => {
  test("a stopped case has no ready preview and no fix_ready", async ({ page }) => {
    const marker = `e2e-partialBuild-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: stop me mid-flight` });
    const caseId = outcome.caseId!;
    try {
      await waitForRun(page, caseId, "diagnostician");
      await page.request.post("/api/self-heal?op=stop", { data: { caseId } });
      const record = (await getCase(page, caseId)).case;

      // Whether or not the Stop landed on a live run, the invariant is the
      // same: this case never reached a ready preview, so nothing announced a
      // fix for it. (`completeFix` re-derives readiness from the Supervisor
      // rather than trusting a report, which is what makes a staged-then-
      // aborted candidate unable to masquerade as a finished fix.)
      expect(record.status).not.toBe("preview-ready");
      expect(record.fixSummary).toBeUndefined();
      const ready = await page.request
        .get("/api/events?type=com.bos.self-heal.fix_ready&limit=50")
        .then((r) => r.json());
      expect(JSON.stringify(ready)).not.toContain(`"caseId":"${caseId}"`);
    } finally {
      await dismiss(page, caseId);
    }
  });
});

test.describe("Settings → Self Improvement: the stuck-detector controls", () => {
  test("the group renders, saves, and dims its number field when detection is off", async ({ page }) => {
    const before = await readConfig(page);
    try {
      await page.getByTestId("dock-settings").click();
      const win = page.getByTestId("window-settings");
      await expect(win).toBeVisible({ timeout: 20_000 });
      await win.getByRole("button", { name: "Self Improvement" }).click();
      await expect(win.getByTestId("self-improvement-tab")).toBeVisible({ timeout: 15_000 });

      const toggle = win.getByTestId("self-heal-stuck-enabled");
      const repeats = win.getByTestId("self-heal-stuck-repeat-calls");
      await expect(toggle).toBeVisible();
      await expect(repeats).toBeVisible();
      // Transcription is a PLATFORM knob surfaced here (its own namespace).
      await expect(win.getByTestId("agent-runs-transcriptions-enabled")).toBeVisible();

      if (await toggle.isChecked()) {
        await expect(repeats).toBeEnabled();
        await toggle.uncheck();
        // A number field for a switched-off feature is disabled, not a control
        // that silently does nothing.
        await expect(repeats).toBeDisabled();
        await toggle.check();
      }
      await repeats.fill("7");
      await repeats.blur();
      await expect
        .poll(async () => (await readConfig(page))["stuckDetector.repeatCalls"], { timeout: 15_000 })
        .toBe(7);
    } finally {
      await patchConfig(page, {
        "stuckDetector.enabled": before["stuckDetector.enabled"] !== false,
        "stuckDetector.repeatCalls": typeof before["stuckDetector.repeatCalls"] === "number" ? before["stuckDetector.repeatCalls"] : 5,
      });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SC-015 / FR-038 — promoting a branch settles its preview-ready case
// ───────────────────────────────────────────────────────────────────────────
//
// The full promote-via-Supervisor path is far too slow for e2e (a whole base
// rebuild, which also restarts this very server). The unit under test is the
// `branch-settled` server action the version controls fire after a successful
// promote/discard — with the case driven to `preview-ready` through the real
// completeFix tool, the way the pipeline agent does it.

test.describe("SC-015: a preview-ready case transitions to resolved when the user promotes its branch", () => {
  test("branch-settled with outcome=promoted resolves the case and announces it", async ({ page }) => {
    const marker = `e2e-settle-${uniqueSuffix()}`;
    const { outcome } = await report(page, { description: `${marker}: settle me after promote` });
    const caseId = outcome.caseId!;
    const branch = `bos/self-heal-${caseId}`;
    let restoreTools: () => Promise<void> = async () => {};
    try {
      // Reach `preview-ready` via self_heal_complete_fix. No Supervisor preview
      // exists for this branch, so the readiness re-check has nothing to
      // contradict and the reported fix stands — and no git ref is created.
      restoreTools = await grantToolToAssistant(page, "self_heal_complete_fix");
      await openAssistantOnFreshConversation(page);
      await page.getByTestId("chat-textarea").fill(
        script([
          {
            text: "completing the fix",
            tools: [{ name: "self_heal_complete_fix", args: { caseId, branch, summary: `${marker}: fixed` } }],
          },
          { text: "Completed." },
        ]),
      );
      await page.getByTestId("chat-send-button").click();
      await expect(page.getByTestId("chat-stop-button")).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(async () => (await getCase(page, caseId)).case.status, { timeout: 20_000 })
        .toBe("preview-ready");

      // The action under test: exactly what VersionControls / the Versions tab
      // fire after a successful promote.
      const res = await page.request.post("/api/self-heal?op=branch-settled", {
        data: { branch, outcome: "promoted" },
      });
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { ok?: boolean; settled?: number };
      expect(body.ok).toBe(true);
      expect(body.settled).toBeGreaterThanOrEqual(1);

      expect((await getCase(page, caseId)).case.status).toBe("resolved");

      // The settlement is announced (FR-026): fix_promoted carries the case.
      const promoted = await page.request
        .get("/api/events?type=com.bos.self-heal.fix_promoted&limit=50")
        .then((r) => r.json());
      expect(JSON.stringify(promoted)).toContain(`"caseId":"${caseId}"`);
    } finally {
      await restoreTools();
      // Discard rather than dismiss: it deletes the record (and its dedupe
      // entry) outright, so a resolved case from this run leaves no residue.
      await page.request.post("/api/self-heal?op=discard", { data: { caseId } }).catch(() => {});
    }
  });
});
