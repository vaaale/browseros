import { NextRequest, NextResponse } from "next/server";
import { startReconcileJob, getReconcileJob } from "@/lib/gitops/reconcile-jobs";
import type { ReconcileOptions } from "@/lib/gitops/reconcile";
import { gitLogger } from "@/lib/gitops/logging";
import type { MergeStrategy } from "@/lib/gitops/git-ops";
import type { RepoKind, WorkMode } from "@/lib/gitops/sessions/types";
import { resolveAuth, type AuthType } from "@/lib/gitops/auth";
import { readRemoteConfigs } from "@/lib/gitops/remote-config";
import { SOURCE_FS_ID } from "@/lib/gitops/filesystems";

export const dynamic = "force-dynamic";

// Internal, same-host entry point for the shared reconciliation pipeline
// (001-external-repo-integration, User Story 6). The sole caller is the
// Supervisor (tools/supervisor/supervisor.mjs — a separate Node process),
// during promote. Trust boundary: same as /api/health — no session is
// required because the caller is the Supervisor itself, not a browser.
//
// Job-based, not a single blocking call: escalation can take many minutes,
// and the Supervisor needs to see "we're now escalated" (and the
// conversation id) the moment it happens — not only once the whole
// reconciliation eventually finishes (see AS7: a browser refresh must show
// the escalated state immediately). POST starts a job and returns right
// away; GET polls it. The job itself runs to completion regardless of
// whether anything polls it.

const MERGE_STRATEGIES: MergeStrategy[] = ["merge-squash", "merge", "commit"];
const REPO_KINDS: RepoKind[] = ["source", "user-specs", "user-apps", "vfs-mount", "generic"];

function err(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// The credential a remote uses. Mirrors /api/git-remotes/route.ts's
// authTypeFor: persisted on the config since 018; legacy remotes without it
// fall back to the provider default (github/gitlab connect via provider-wide
// OAuth, everything else via a per-remote token).
function authTypeFor(config: { authType?: string; provider?: string } | undefined): AuthType {
  if (config?.authType) return config.authType as AuthType;
  return config?.provider === "github" || config?.provider === "gitlab" ? "oauth" : "token";
}

/** Resolve credentials for `remote` the same way the git_merge/git_sync tools
 *  and /api/git-remotes do — via any registered remote config for it (the
 *  BOS source filesystem by default, since the sole current caller is the
 *  Supervisor reconciling its own promote). Returns undefined (not an error)
 *  when there's no registered config — the git call then falls back to
 *  whatever's already configured directly on the remote URL / system git
 *  credential store, exactly as before this auth resolution existed. */
async function resolveRemoteAuth(remote: string | undefined, filesystem: string) {
  if (!remote) return undefined;
  const configs = readRemoteConfigs();
  const config = configs.find((c) => (c.filesystem ?? SOURCE_FS_ID) === filesystem && c.name === remote);
  const auth = await resolveAuth(remote, authTypeFor(config), config?.provider).catch(() => null);
  return auth ?? undefined;
}

export async function POST(req: NextRequest) {
  const op = "api.gitfs_reconcile.start";
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("INVALID_BODY", "Request body must be JSON.");
  }

  const repoPath = typeof body.repoPath === "string" ? body.repoPath : "";
  const remote = typeof body.remote === "string" && body.remote ? body.remote : undefined;
  const branch = typeof body.branch === "string" && body.branch ? body.branch : undefined;
  const sourceRef = typeof body.sourceRef === "string" ? body.sourceRef : "";
  const strategy = typeof body.strategy === "string" ? (body.strategy as MergeStrategy) : "merge-squash";
  const featureBranchForDelegate = typeof body.featureBranchForDelegate === "string" ? body.featureBranchForDelegate : undefined;
  const escalationContext = typeof body.escalationContext === "string" ? body.escalationContext : undefined;
  const maxEscalationWaitMs = typeof body.maxEscalationWaitMs === "number" ? body.maxEscalationWaitMs : undefined;

  if (!repoPath || !sourceRef) {
    return err("MISSING_PARAMS", "repoPath and sourceRef are required.");
  }
  if (!!remote !== !!branch) {
    return err("MISSING_PARAMS", "remote and branch must be given together (or both omitted for a purely local reconciliation).");
  }
  if (!MERGE_STRATEGIES.includes(strategy)) {
    return err("INVALID_STRATEGY", `strategy must be one of: ${MERGE_STRATEGIES.join(", ")}.`);
  }

  const filesystem = typeof body.filesystem === "string" && body.filesystem ? body.filesystem : SOURCE_FS_ID;
  const auth = await resolveRemoteAuth(remote, filesystem);

  // 035: the escalation's WORKING CONTEXT, passed straight through from the
  // caller. This is what lets the Supervisor (a separate Node process that
  // never imports BOS `@/` source) route a spec-store or user-apps conflict
  // into the same pipeline with the right repo parameters — the access
  // mechanism is identical, only these values differ (FR-003/FR-004).
  const repoKind = REPO_KINDS.includes(body.repoKind as RepoKind) ? (body.repoKind as RepoKind) : undefined;
  const repoRoot = typeof body.repoRoot === "string" && body.repoRoot ? body.repoRoot : undefined;
  const repoLabel = typeof body.repoLabel === "string" && body.repoLabel ? body.repoLabel : undefined;
  const mode = body.mode === "plumbing" || body.mode === "working-tree" ? (body.mode as WorkMode) : undefined;
  const operationLabel = typeof body.operationLabel === "string" && body.operationLabel ? body.operationLabel : undefined;
  const completion =
    body.completion && typeof body.completion === "object"
      ? (body.completion as ReconcileOptions["completion"])
      : undefined;

  const opts: ReconcileOptions = {
    repoPath,
    remote,
    branch,
    sourceRef,
    strategy,
    auth,
    featureBranchForDelegate,
    escalationContext,
    maxEscalationWaitMs,
    repoKind,
    repoRoot,
    repoLabel,
    mode,
    operationLabel,
    completion,
  };

  gitLogger().info({ op, repoPath, remote, success: true, error: undefined });
  const jobId = startReconcileJob(opts);
  return NextResponse.json({ ok: true, jobId, phase: "running" });
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return err("MISSING_PARAMS", "jobId query param is required.");

  const job = getReconcileJob(jobId);
  if (!job) return err("JOB_NOT_FOUND", `No reconcile job "${jobId}" (it may have finished and been reaped, or never existed).`, 404);

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    phase: job.phase,
    devopsConversationId: job.devopsConversationId,
    sessionId: job.sessionId,
    outcome: job.outcome,
  });
}
