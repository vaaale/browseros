import { NextRequest, NextResponse } from "next/server";
import { listMounts } from "@/lib/gitops/mount-manager";
import { getSyncStatus, hasConflict, resolveConflict, mountWorkContext } from "@/lib/gitops/sync-status";
import { reconcile } from "@/lib/gitops/reconcile";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";

export const dynamic = "force-dynamic";

function err(code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: 400 });
}

export async function GET() {
  try {
    const mounts = listMounts();
    const statuses = await Promise.all(
      mounts.map(async (m) => {
        try {
          const status = await getSyncStatus(m.remoteName);
          const conflict = status.localAhead > 0 && status.localBehind > 0;
          return { ...status, conflict };
        } catch {
          return {
            remoteName: m.remoteName,
            branch: m.branch,
            localAhead: 0,
            localBehind: 0,
            hasUncommittedChanges: false,
            conflict: false,
            lastFetched: null,
            lastSynced: m.lastSynced ?? null,
          };
        }
      }),
    );
    return NextResponse.json({ statuses });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "");

    switch (action) {
      case "fetch-all": {
        const mounts = listMounts();
        const lock = gitLock();
        return await lock.withLock(process.cwd(), "api.git_sync_fetch_all", async (release) => {
          try {
            const statuses = await Promise.all(
              mounts.map(async (m) => {
                try {
                  const status = await getSyncStatus(m.remoteName);
                  return { ...status, conflict: status.localAhead > 0 && status.localBehind > 0 };
                } catch {
                  return {
                    remoteName: m.remoteName,
                    branch: m.branch,
                    localAhead: 0,
                    localBehind: 0,
                    hasUncommittedChanges: false,
                    conflict: false,
                    lastFetched: null,
                    lastSynced: m.lastSynced ?? null,
                  };
                }
              }),
            );
            gitLogger().info({ op: "api.git_sync_fetch_all", success: true });
            return NextResponse.json({ ok: true, statuses });
          } finally {
            await release();
          }
        });
      }

      case "check-conflict": {
        const { remoteName } = body;
        if (!remoteName) return err("MISSING_PARAMS", "remoteName is required.");
        const conflict = await hasConflict(remoteName);
        return NextResponse.json({ ok: true, conflict });
      }

      case "resolve": {
        const { remoteName, strategy } = body;
        if (!remoteName || !strategy) {
          return err("MISSING_PARAMS", "remoteName and strategy are required.");
        }
        if (!["merge", "rebase"].includes(strategy)) {
          return err("INVALID_STRATEGY", "strategy must be 'merge' or 'rebase'.");
        }

        const lock = gitLock();
        return await lock.withLock(process.cwd(), "api.git_sync_resolve", async (release) => {
          try {
            const result = await resolveConflict(remoteName, strategy);
            if (result.status === "conflict") {
              // 035 (FR-016, discovered by the completeness sweep): a mounted
              // repo whose chosen strategy conflicts used to end here as a
              // 400 with no agent. It now escalates like every other repo —
              // the ONLY difference is this working context (FR-003/FR-004).
              const ctx = mountWorkContext(remoteName);
              if (!ctx) return err("NOT_FOUND", `Remote '${remoteName}' is not mounted.`);
              await release();
              const outcome = await reconcile({
                repoPath: ctx.repoPath,
                sourceRef: `origin/${ctx.branch}`,
                strategy: strategy === "rebase" ? "merge" : "merge",
                repoKind: "vfs-mount",
                repoRoot: ctx.repoPath,
                repoLabel: `${remoteName} (mount)`,
                mode: "working-tree",
                operationLabel: "mount sync",
                escalationContext: `Mounted repo "${remoteName}": reconciling against origin/${ctx.branch} with the "${strategy}" strategy conflicted.`,
                completion: { kind: "merge", strategy: "merge" },
              });
              gitLogger().warn({ op: "api.git_sync_resolve", remote: remoteName, error: { code: "RESOLVE_ESCALATED", message: outcome.sessionId ?? "escalated" } });
              return NextResponse.json({
                ok: outcome.status !== "failed",
                escalated: true,
                sessionId: outcome.sessionId,
                devopsConversationId: outcome.devopsConversationId,
                sessionStatus: outcome.sessionStatus ?? outcome.status,
                rollbackTag: outcome.rollbackTag,
                message:
                  outcome.status === "success"
                    ? `Reconciled '${remoteName}' via ${outcome.method}.`
                    : outcome.error?.message ??
                      `The '${strategy}' of '${remoteName}' conflicted and was handed to the conflict-resolution agent — open the resolution to watch or answer it.`,
              });
            }
            gitLogger().info({ op: "api.git_sync_resolve", remote: remoteName, success: true });
            return NextResponse.json({ ok: true, message: `Resolved conflict for '${remoteName}' via ${strategy}.` });
          } catch (e) {
            gitLogger().error({ op: "api.git_sync_resolve", remote: remoteName, error: { code: "RESOLVE_FAILED", message: (e as Error).message } });
            return err("RESOLVE_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      default:
        return err("UNKNOWN_ACTION", `Unknown action '${action}'.`);
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
