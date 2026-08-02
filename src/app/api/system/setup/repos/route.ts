import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { specsRoot } from "@/os/specs-dir";
import { dataDir } from "@/os/data-dir";
import { ensureRepo, commitAll } from "@/lib/gitfs/store";
import { addRemote, fetchRepo, adoptRemote } from "@/lib/gitops/git-ops";
import { addRemoteConfig } from "@/lib/gitops/remote-config";
import { STORE_MANIFEST, type StoreManifest } from "@/lib/specs/stores";

export const dynamic = "force-dynamic";

const SYSTEM_STORE_ID = "bos-system-specs";

const SYSTEM_MANIFEST: StoreManifest = {
  label: "System specs",
  owner: "system",
  writable: false,
  requiresPromote: true,
};

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function hasRemote(dir: string): Promise<boolean> {
  try {
    const config = await fs.readFile(path.join(dir, ".git", "config"), "utf8");
    return config.includes("[remote ");
  } catch { return false; }
}

/** Clone/adopt a remote into a git repo at `dir`, then register it in the
 *  remote-config store under `filesystem`. Idempotent: skips addRemote if
 *  the remote already exists. */
async function cloneInto(
  dir: string,
  url: string,
  branch: string,
  filesystem: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await ensureRepo(dir);
  if (!await hasRemote(dir)) {
    await addRemote(dir, "origin", url);
  }
  await fetchRepo(dir, "origin", branch, undefined);
  await adoptRemote(dir, "origin", branch);
  addRemoteConfig({
    name: "origin",
    url,
    provider: detectProvider(url),
    authType: "token",
    autoPush: false,
    defaultBranch: branch || undefined,
    filesystem,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { op?: string; url?: string; branch?: string };
    const { op, url = "", branch = "" } = body;

    // ── bos-specs ─────────────────────────────────────────────────────────────
    if (op === "bos-specs") {
      const specsDir = path.join(specsRoot(), SYSTEM_STORE_ID);

      if (url) {
        await cloneInto(specsDir, url, branch || "master", SYSTEM_STORE_ID);
        // Overwrite the manifest (adoption may have replaced it with the remote's)
        await fs.writeFile(
          path.join(specsDir, STORE_MANIFEST),
          JSON.stringify(SYSTEM_MANIFEST, null, 2) + "\n",
        );
        await commitAll(specsDir, "setup: adopt remote specs");
      }
      // If no URL: the seed already ran at startup — nothing to do.
      return NextResponse.json({ ok: true });
    }

    // ── user-apps ──────────────────────────────────────────────────────────────
    if (op === "user-apps") {
      const userAppsDir = path.join(dataDir(), "user-apps");
      await fs.mkdir(userAppsDir, { recursive: true });

      if (url) {
        await cloneInto(userAppsDir, url, branch || "main", "user-apps");
      } else {
        // Ensure it exists as a git repo so it appears in Settings → Versions.
        const fresh = !(await pathExists(path.join(userAppsDir, ".git")));
        await ensureRepo(userAppsDir);
        if (fresh) await commitAll(userAppsDir, "init user apps");
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown op '${String(op)}'` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
