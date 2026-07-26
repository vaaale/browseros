import "server-only";
import { reconcile, type ReconcileOptions, type ReconcileOutcome } from "./reconcile";
import { gitLogger } from "./logging";

// In-memory job wrapper around reconcile() so a same-host, cross-process
// caller (the Supervisor, tools/supervisor/supervisor.mjs) can poll progress
// instead of holding one HTTP connection open for the whole pipeline
// (potentially 20+ minutes once escalated). Without this, the Supervisor
// would have no way to know "we're now escalated" until the entire call
// finally returns — breaking the "a browser refresh shows the escalated
// state immediately" guarantee (001-external-repo-integration, User Story 6,
// AS7). The job itself still runs to completion regardless of whether
// anything polls it, exactly like `reconcile()` does on its own.

export type ReconcileJobPhase = "running" | "escalated" | "done";

export interface ReconcileJob {
  id: string;
  phase: ReconcileJobPhase;
  devopsConversationId?: string;
  outcome?: ReconcileOutcome;
  startedAt: number;
}

const jobs = new Map<string, ReconcileJob>();
const JOB_RETENTION_MS = 60 * 60 * 1000; // 1 hour — plenty of time for a poller to see the final outcome

function newJobId(): string {
  return `reconcile-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Start a reconciliation job in the background and return its id
 *  immediately. Callers poll `getReconcileJob(id)` for progress. */
export function startReconcileJob(opts: ReconcileOptions): string {
  const id = newJobId();
  const job: ReconcileJob = { id, phase: "running", startedAt: Date.now() };
  jobs.set(id, job);
  gitLogger().info({ op: "gitops.reconcileJob.start", repoPath: opts.repoPath, remote: opts.remote, success: true, error: undefined });

  void reconcile({
    ...opts,
    onEscalate: (conversationId) => {
      job.phase = "escalated";
      job.devopsConversationId = conversationId;
      gitLogger().info({ op: "gitops.reconcileJob.escalated", repoPath: opts.repoPath, remote: opts.remote, success: true, error: undefined });
      opts.onEscalate?.(conversationId);
    },
  })
    .then((outcome) => {
      job.phase = "done";
      job.outcome = outcome;
      if (outcome.devopsConversationId) job.devopsConversationId = outcome.devopsConversationId;
      gitLogger().info({ op: "gitops.reconcileJob.done", repoPath: opts.repoPath, remote: opts.remote, success: outcome.status !== "failed", error: outcome.error });
    })
    .catch((e) => {
      const message = (e as Error).message ?? String(e);
      job.phase = "done";
      job.outcome = { status: "failed", rollbackTag: "", error: { code: "RECONCILE_JOB_FAILED", message } };
      gitLogger().error({ op: "gitops.reconcileJob.done", repoPath: opts.repoPath, remote: opts.remote, success: false, error: { code: "RECONCILE_JOB_FAILED", message } });
    })
    .finally(() => {
      setTimeout(() => jobs.delete(id), JOB_RETENTION_MS).unref();
    });

  return id;
}

export function getReconcileJob(id: string): ReconcileJob | undefined {
  return jobs.get(id);
}
