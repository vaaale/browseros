import "server-only";
import { gitLogger } from "../logging";
import { emitEscalatedEvent, loadSessionsFromDisk, relaunchAgent, setSessionRun } from "./store";
import { isTerminalStatus, type ConflictSession } from "./types";

// 035-spec-promote-conflict-escalation (FR-024, D3) — the boot sweep.
//
// The session is durable (a file under `data/gitops/sessions/`). The agent RUN
// is not: `runManager` is in-memory and empty on boot, so after a restart
// every `working` session's run is dead by definition. Two cases:
//
//   working       → re-launch the run on the SAME conversation. The transcript
//                   is intact, so the agent carries on with all its context.
//   awaiting-user → restore only. It is parked on the user, indefinitely (D3);
//                   re-launching would be the agent talking to itself. It
//                   re-wakes when the user answers, exactly as before.
//
// Both then re-emit `com.bos.gitops.conflict.escalated` so the topbar
// subscriber re-opens the Build Studio pane.
//
// NOTE (design §9.2): this re-emit is deliberately NOT `redispatchPendingOnBoot`.
// That mechanism re-enqueues *pending* events to *active headless handlers* —
// and this event has no headless handler at all, so the kernel settles it as
// `processed/no-active-handlers` the instant it is emitted. It is never
// "pending", so redispatch would never re-fire it. The explicit emit below is
// the only thing that works, and it is also simply clearer.

const OP = "gitops.conflict-session.recover";

export interface RecoveryReport {
  relaunched: string[];
  restored: string[];
  reEmitted: string[];
}

/** Seams, defaulted to the real implementations. Injectable so the sweep's
 *  CLASSIFICATION (which sessions re-launch, which are merely restored, which
 *  are skipped) can be tested without standing up the assistant run loop and
 *  the event kernel — that classification is the whole contract of FR-024. */
export interface RecoveryDeps {
  relaunch?: (session: ConflictSession, message: string) => Promise<void>;
  emit?: (session: ConflictSession) => Promise<void>;
  clearRun?: (id: string) => Promise<void>;
}

export async function recoverSessions(deps: RecoveryDeps = {}): Promise<RecoveryReport> {
  const relaunch = deps.relaunch ?? relaunchAgent;
  const emit = deps.emit ?? emitEscalatedEvent;
  const clearRun = deps.clearRun ?? ((id: string) => setSessionRun(id, null));
  const report: RecoveryReport = { relaunched: [], restored: [], reEmitted: [] };
  let sessions: ConflictSession[];
  try {
    sessions = await loadSessionsFromDisk();
  } catch (e) {
    gitLogger().error({
      op: OP,
      repoPath: "",
      success: false,
      error: { code: "SESSION_SWEEP_FAILED", message: (e as Error).message },
    });
    return report;
  }

  for (const session of sessions) {
    if (isTerminalStatus(session.status)) continue;
    try {
      if (session.status === "working") {
        // The run died with the process. Clear the stale id first so nothing
        // mistakes it for a live run while the new one starts.
        await clearRun(session.id);
        await relaunch(
          session,
          [
            `Resuming conflict session \`${session.id}\` after a BrowserOS restart.`,
            `repo_path: ${session.workContext.repoPath}`,
            "",
            "Call `conflict_status` first to see exactly what is already resolved and what is still open, then continue from there. Do not redo work that is already recorded.",
          ].join("\n"),
        );
        report.relaunched.push(session.id);
      } else {
        // awaiting-user: parked on the user. Restoring the durable state is
        // the whole job — the run re-launches when they answer.
        report.restored.push(session.id);
      }

      await emit(session);
      report.reEmitted.push(session.id);
    } catch (e) {
      // One unrecoverable session must never stop the others from recovering.
      gitLogger().warn({
        op: OP,
        repoPath: session.workContext.repoPath,
        error: { code: "SESSION_RECOVERY_FAILED", message: `${session.id}: ${(e as Error).message}` },
      });
    }
  }

  if (report.relaunched.length || report.restored.length) {
    gitLogger().info({
      op: OP,
      repoPath: "",
      success: true,
      error: undefined,
    });
  }
  return report;
}
