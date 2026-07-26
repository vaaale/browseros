import { NextRequest, NextResponse } from "next/server";
import { listMounts, mountRepo, unmountRepo, updateMountStatus } from "@/lib/gitops/mount-manager";
import { getSyncStatus } from "@/lib/gitops/sync-status";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";

export const dynamic = "force-dynamic";

function err(code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: 400 });
}

export async function GET() {
  try {
    const mounts = listMounts();
    return NextResponse.json({ mounts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "");

    switch (action) {
      case "mount": {
        const { remoteName, mountPath, branch } = body;
        if (!remoteName || !mountPath) {
          return err("MISSING_PARAMS", "remoteName and mountPath are required.");
        }

        const lock = gitLock();
        return await lock.withLock(process.cwd(), "api.git_mount", async (release) => {
          try {
            const config = mountRepo(remoteName, mountPath, branch ?? "main");
            gitLogger().info({ op: "api.git_mount", remote: remoteName, success: true });
            return NextResponse.json({ ok: true, mount: config });
          } catch (e) {
            gitLogger().error({ op: "api.git_mount", remote: remoteName, error: { code: "MOUNT_FAILED", message: (e as Error).message } });
            return err("MOUNT_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "unmount": {
        const { remoteName } = body;
        if (!remoteName) return err("MISSING_PARAMS", "remoteName is required.");

        const lock = gitLock();
        return await lock.withLock(process.cwd(), "api.git_unmount", async (release) => {
          try {
            const ok = unmountRepo(remoteName);
            if (!ok) return err("NOT_FOUND", `Remote "${remoteName}" is not mounted.`);
            gitLogger().info({ op: "api.git_unmount", remote: remoteName, success: true });
            return NextResponse.json({ ok: true, message: `Unmounted '${remoteName}'.` });
          } catch (e) {
            gitLogger().error({ op: "api.git_unmount", remote: remoteName, error: { code: "UNMOUNT_FAILED", message: (e as Error).message } });
            return err("UNMOUNT_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "sync": {
        const { remoteName } = body;
        if (!remoteName) return err("MISSING_PARAMS", "remoteName is required.");

        const lock = gitLock();
        return await lock.withLock(process.cwd(), "api.git_sync_mount", async (release) => {
          try {
            updateMountStatus(remoteName, "syncing");
            const status = await getSyncStatus(remoteName);
            const hasConflicts = status.localAhead > 0 && status.localBehind > 0;
            updateMountStatus(remoteName, hasConflicts ? "error" : "synced");
            gitLogger().info({ op: "api.git_sync_mount", remote: remoteName, success: true });
            return NextResponse.json({ ok: true, status });
          } catch (e) {
            updateMountStatus(remoteName, "error");
            gitLogger().error({ op: "api.git_sync_mount", remote: remoteName, error: { code: "SYNC_FAILED", message: (e as Error).message } });
            return err("SYNC_FAILED", (e as Error).message);
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
