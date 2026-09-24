import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as intake from "../../src/lib/self-heal/intake";
import { storeDiagnosticsReport } from "../../src/lib/self-heal/diagnostician";
import { createCase, getCase, updateCase } from "../../src/lib/self-heal/store";
import { computeFailureSignature } from "../../src/lib/self-heal/signature";
import { _resetRunRegistryForTests, registerRun } from "../../src/lib/agent/subagents/run-registry";
import { selfHealBranchFor, type TriggerContext } from "../../src/lib/self-heal/types";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing scope-add — R-SA5 / S3: an ABORTED run's partial build must
// never look like a finished fix.
//
// Why this test exists, concretely. Stopping a pipeline run kills the Developer
// CLI child mid-edit, and that child's close handler still stages what it wrote
// (deliberately — half-written work is more recoverable staged than lost), so
// the Supervisor may well go on to build a PARTIAL candidate for the branch. If
// such a build could reach the `ready` state, then `completeFix`'s preview check
// — or the boot reconcile's `ready` → `fix_ready` path — would announce a fix
// that does not exist, on a branch nobody finished.
//
// The guard is that BOS never takes the agent's word for a fix: readiness is
// re-derived from the Supervisor, and a partial/interrupted candidate is not
// `ready`. These tests pin that end of it — the state the Supervisor reports for
// an aborted candidate is not `ready`, and every path that could emit
// `fix_ready` refuses when it isn't.

const HARD: TriggerContext = { trigger: "hard-error", toolName: "file_search", errorMessage: "no content grep" };
const ALL_ON = { enabled: true, "triggers.hardError": true, "triggers.explicit": true };

async function diagnosedClassE(): Promise<string> {
  const record = await createCase({
    trigger: "hard-error",
    title: "file_grep is missing",
    signature: computeFailureSignature(HARD),
    context: HARD,
  });
  await storeDiagnosticsReport(
    record.id,
    {
      caseId: record.id,
      scopeClass: "e",
      ownership: "bos-core",
      proposedSurface: "src/lib/assistant/tools/server/file-tools.ts",
      verdict: "genuine gap: there is no content-grep tool",
    },
    "## Investigation\n\nThere is no `file_grep`.",
  );
  return record.id;
}

/** A Supervisor that reports whatever state the test sets for the branch —
 *  `building` is what a staged-then-interrupted candidate actually looks like. */
async function stubSupervisor(read: () => { branch: string; state: string }) {
  const http = await import("node:http");
  const previous = process.env.BOS_SUPERVISOR_URL;
  const server = http.createServer((_req, res) => {
    const { branch, state } = read();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ previews: [{ role: "preview", branch, state }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  process.env.BOS_SUPERVISOR_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return () => {
    server.close();
    if (previous === undefined) delete process.env.BOS_SUPERVISOR_URL;
    else process.env.BOS_SUPERVISOR_URL = previous;
  };
}

test.afterEach(() => {
  intake._setSpineAgentHooksForTests(null);
  _resetRunRegistryForTests();
});

test.describe("R-SA5 — an aborted run's partial build is not a fix", () => {
  test("Stop mid-run leaves the preview un-ready, and completeFix refuses to announce", async () => {
    const root = useSelfHealTestRoot("partial-build-stop");
    _resetRunRegistryForTests();
    let branch = "";
    // The candidate was staged and the build interrupted: the Supervisor is
    // still mid-build, which is exactly NOT ready.
    const restore = await stubSupervisor(() => ({ branch, state: "building" }));
    try {
      root.writeConfig(ALL_ON);
      const runId = "headless-build-studio-partial";
      intake._setSpineAgentHooksForTests({
        agentAvailable: async () => true,
        runPipeline: async ({ onEvent }) =>
          new Promise((_resolve, reject) => {
            registerRun(runId, { agentId: "build-studio", abort: () => reject(new Error("Cancelled by user")) });
            onEvent?.({ type: "run_started", runId, agentId: "build-studio", startedAt: new Date().toISOString() });
            // Mid-`dev_delegate`: the nested Developer is editing the worktree
            // when the user presses Stop.
            onEvent?.({ tool: "dev_delegate", input: { task: "add file_grep" } });
          }),
      });

      const caseId = await diagnosedClassE();
      branch = selfHealBranchFor(caseId);
      await intake.resolveDiagnosedCase(caseId);
      await expect.poll(async () => (await getCase(caseId))?.runs?.length ?? 0).toBe(1);

      await intake.stopRun(caseId);
      expect((await getCase(caseId))?.status).toBe("stopped");

      // The load-bearing assertion (R-SA5): the partial build is NOT ready.
      expect(await intake.previewStateFor(branch)).not.toBe("ready");

      // So the fix-completion path refuses rather than emitting a false
      // `fix_ready` — BOS checks the build instead of trusting a report.
      const done = await intake.completeFix({ caseId, branch, summary: "claiming a fix that was never finished" });
      expect(done.ok).toBe(false);
      if (!done.ok) expect(done.error).toContain("not ready");
      const after = await getCase(caseId);
      expect(after?.status).not.toBe("preview-ready");
      expect(after?.fixSummary).toBeUndefined();
    } finally {
      restore();
      await root.cleanup();
    }
  });

  test("boot reconcile does not turn an interrupted candidate into a fix", async () => {
    const root = useSelfHealTestRoot("partial-build-reconcile");
    let branch = "";
    const restore = await stubSupervisor(() => ({ branch, state: "building" }));
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      branch = selfHealBranchFor(caseId);
      // The process died with the run in flight — the case is still
      // `bs-pipeline` and the branch has a half-built candidate.
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: branch });

      const summary = await intake.reconcileInFlightCases();
      expect(summary.fixReadyEmitted).not.toContain(caseId);
      // `building` is still in progress, so the reconcile leaves it alone
      // rather than inventing a verdict either way.
      expect((await getCase(caseId))?.status).toBe("bs-pipeline");
    } finally {
      restore();
      await root.cleanup();
    }
  });

  test("a failed partial candidate is recorded as failed, never as ready", async () => {
    const root = useSelfHealTestRoot("partial-build-failed");
    let branch = "";
    const restore = await stubSupervisor(() => ({ branch, state: "failed" }));
    try {
      root.writeConfig(ALL_ON);
      const caseId = await diagnosedClassE();
      branch = selfHealBranchFor(caseId);
      await updateCase(caseId, { status: "bs-pipeline", activeFeatureBranch: branch });

      expect(await intake.previewStateFor(branch)).toBe("failed");
      const summary = await intake.reconcileInFlightCases();
      expect(summary.fixReadyEmitted).not.toContain(caseId);
      expect(summary.failed).toContain(caseId);
      expect((await getCase(caseId))?.status).toBe("failed");
    } finally {
      restore();
      await root.cleanup();
    }
  });
});
