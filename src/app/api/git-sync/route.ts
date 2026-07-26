import { NextRequest, NextResponse } from "next/server";
import { listMounts } from "@/lib/gitops/mount-manager";
import { getSyncStatus, hasConflict, resolveConflict } from "@/lib/gitops/sync-status";
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
            await resolveConflict(remoteName, strategy);
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
