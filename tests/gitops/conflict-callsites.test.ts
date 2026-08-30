// 035-spec-promote-conflict-escalation — the call-site conversions (T025) and
// the FR-016 completeness invariant (T040), as an executable check.
//
// FR-016 is a whole-system invariant: NO git conflict path may dead-end with a
// static "resolve manually" error and no agent. That is precisely the kind of
// property that decays silently — one new `catch { merge --abort; return
// "resolve manually" }` and the guarantee is gone with nothing failing. So it
// is asserted against the real source here, not just in a review checklist.
//
//   npm run test:unit -- tests/gitops/conflict-callsites.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("FR-012: promoteFeature routes its conflict through the pipeline with the user-specs context", () => {
  const src = read("src/lib/specs/promote.ts");
  expect(src).toContain("reconcile(");
  expect(src).toContain('repoKind: "user-specs"');
  // The completion plan is what makes resolving the session finish the promote
  // itself: main fast-forwards and the worktree is pruned (FR-011/FR-017).
  expect(src).toContain("ff: { repoRoot, baseBranch: base, ffBranch: branch }");
  expect(src).toContain("pruneWorktree:");
  // The old dead-end shape (return the conflict, no agent) is gone.
  expect(src).not.toMatch(/return\s*\{\s*kind:\s*"conflict",\s*files\s*\}/);
});

test("FR-013/FR-014: git-remotes fetch and push-recovery escalate instead of returning rebaseConflict", () => {
  const src = read("src/app/api/git-remotes/route.ts");
  // No response may carry the old static dead-end flag any more.
  expect(code(src)).not.toMatch(/rebaseConflict:\s*true/);
  expect(code(src)).not.toContain("resolve manually, or force-push");
  // Both paths go through the one shared escalation helper.
  const escalations = src.match(/escalateRebaseConflict\(\{/g) ?? [];
  expect(escalations.length).toBe(2);
  expect(src).toContain('operationLabel: "pull"');
  expect(src).toContain('operationLabel: "push (non-fast-forward recovery)"');
  // The per-repo working context is derived from the target filesystem, not
  // hard-coded to the source repo (FR-003/FR-004).
  expect(src).toContain("repoKind: repoKindFor(fsId)");
  // reconcile() re-takes the per-repo lock, so the route must let go of it
  // first — otherwise every escalation would stall on its own lock.
  expect(src).toMatch(/await release\(\);\s*\n\s*return NextResponse\.json\(\s*\n?\s*await escalateRebaseConflict/);
});

test("FR-012a: the Supervisor's coupled-repo pre-check escalates instead of throwing (the reported bug)", () => {
  const promote = read("tools/supervisor/lib/promote.mjs");
  const coupled = read("tools/supervisor/lib/coupled-repos.mjs");

  // The exact dead-end from the repro — `throw new Error("promote blocked — …")`
  // straight off the pre-check — is gone; the pre-check now resolves first.
  expect(promote).toContain("resolveCoupledConflicts(repo, cand.branch, onCoupledEscalate)");
  expect(promote).not.toMatch(/const conflict = await coupledConflicts\(/);

  // The pre-check itself routes through the loopback pipeline...
  expect(coupled).toContain("reconcileViaApi(");
  expect(coupled).toContain('repoKind: repo.kind === "user-apps" ? "user-apps" : "user-specs"');
  // ...and the Supervisor still never imports BOS source (D4).
  expect(coupled).not.toMatch(/from ["']@\//);
  expect(promote).not.toMatch(/from ["']@\//);
});

test("FR-012a: promoteCoupled's merge-abort warning is now an escalation", () => {
  const coupled = read("tools/supervisor/lib/coupled-repos.mjs");
  // The old terminal message told the user to go do it themselves.
  expect(coupled).not.toContain("merge manually in ${repo.root}");
  expect(coupled).toMatch(/resolveCoupledConflicts\(repo, branch, onEscalate\)/);
});

test("FR-015: user-apps has exactly ONE merge path, and it is the escalating coupled one", () => {
  // app-candidate.mjs used to be a SECOND branch scheme over user-apps, with
  // its own appPromote merge (escalated via reconcileViaApi). It is retired:
  // user-apps is branch-coupled like every spec store, so its only merge is
  // promoteCoupled's — already asserted to escalate by the two tests above.
  // Asserting the file's absence is what keeps a second path from quietly
  // coming back with no conflict handling of its own (the FR-016 invariant).
  expect(existsSync(join(ROOT, "tools/supervisor/lib/app-candidate.mjs"))).toBe(false);
  const control = read("tools/supervisor/lib/control.mjs");
  for (const route of ["app-begin", "app-promote", "app-discard"]) {
    expect(control).not.toContain(route);
  }
});

test("FR-018: the session id reaches every escalating caller's response", () => {
  expect(read("src/lib/gitops/reconcile.ts")).toContain("sessionId?: string;");
  expect(read("src/lib/gitops/reconcile-jobs.ts")).toContain("sessionId");
  expect(read("src/app/api/gitfs/reconcile/route.ts")).toContain("sessionId: job.sessionId");
  expect(read("tools/supervisor/lib/reconcile-client.mjs")).toContain("onEscalate?.(devopsConversationId, sessionId)");
  expect(read("tools/supervisor/lib/promote.mjs")).toContain("sessionId: conflictSessionId");
});

test("FR-016 (sweep finding): the git-sync mount resolve path escalates too (S6)", () => {
  const lib = read("src/lib/gitops/sync-status.ts");
  const route = read("src/app/api/git-sync/route.ts");
  // The leaf reports a conflict rather than throwing a dead-end...
  expect(lib).toContain('return { status: "conflict" }');
  // ...and the route routes it through the pipeline with the MOUNT's context —
  // the same machinery, only the working context differs (FR-003/FR-004).
  expect(route).toContain("reconcile({");
  expect(route).toContain('repoKind: "vfs-mount"');
  expect(route).toContain("mountWorkContext(remoteName)");
  expect(route).toContain("sessionId: outcome.sessionId");
});

test("FR-019: all four surfaces render the live session, not a static dead-end string", () => {
  for (const rel of [
    "src/components/desktop/VersionControls.tsx",
    "src/components/apps/settings/VersionsTab.tsx",
    "src/components/apps/settings/versions/ConflictResolutionDialog.tsx",
    "src/components/apps/settings/versions/GitRemotesTab.tsx",
  ]) {
    expect(read(rel), rel).toContain("ConflictSessionBadge");
  }
  // The specific strings this feature exists to delete (comments that quote
  // them while explaining the change don't count).
  expect(code(read("src/components/desktop/VersionControls.tsx"))).not.toContain("escalated to DevOps Agent");
  expect(code(read("src/components/apps/settings/versions/GitRemotesTab.tsx"))).not.toContain(
    "resolve the conflicts with a manual merge on the command line",
  );
});

/** Strip comments before sweeping. The invariant is about what the CODE does;
 *  a comment that quotes the old dead-end string (explaining what was removed
 *  and why) is documentation, not a violation. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

/** Every TS/JS source file under `src/` and `tools/supervisor/`. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "tools", "supervisor"));
  return out;
}

test("FR-016 completeness sweep: no conflict path dead-ends with a static 'resolve manually'", () => {
  // The user-visible shape of the bug this feature exists to remove: a git
  // conflict that reports itself as the user's problem, with no agent.
  const deadEndPhrases = [
    /rebaseConflict:\s*true/,
    /resolve manually, or force-push/,
    /merge manually in/,
    /promote blocked — \$\{conflict\}/,
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const src = code(readFileSync(file, "utf8"));
    for (const phrase of deadEndPhrases) {
      if (phrase.test(src)) offenders.push(`${file.replace(`${ROOT}/`, "")} :: ${phrase}`);
    }
  }
  expect(offenders, `dead-end conflict paths still present:\n${offenders.join("\n")}`).toEqual([]);
});

test("FR-016 completeness sweep: every conflict-tolerating call site routes through the pipeline", () => {
  // `merge --abort` / `rebase --abort` are legitimate INSIDE the pipeline and
  // the session store (that is how they leave a repo clean). Anywhere else,
  // aborting a conflicted merge is the signature of a dead-end — so each such
  // file must also reach the pipeline.
  const allowed = new Set([
    "src/lib/gitops/reconcile.ts", // the pipeline itself
    "src/lib/gitops/sessions/store.ts", // rollback + completion
    "src/lib/gitops/git-ops.ts", // the leaf primitives (mergeBranch/rebaseOntoRemote)
    // sync-status.ts is a LEAF now: it reports `{ status: "conflict" }` and
    // its caller (/api/git-sync) escalates. Verified explicitly below.
    "src/lib/gitops/sync-status.ts",
  ]);
  const routesToPipeline = /reconcile\(|reconcileViaApi\(|resolveCoupledConflicts\(|escalateRebaseConflict\(/;
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const rel = file.replace(`${ROOT}/`, "");
    if (allowed.has(rel) || rel.startsWith("tests/")) continue;
    const src = code(readFileSync(file, "utf8"));
    if (!/(merge|rebase)["'\s,\]]*--abort|MERGE_CONFLICT|REBASE_CONFLICT/.test(src)) continue;
    if (!routesToPipeline.test(src)) offenders.push(rel);
  }
  expect(offenders, `conflict-aborting sites that never reach the pipeline:\n${offenders.join("\n")}`).toEqual([]);
});
