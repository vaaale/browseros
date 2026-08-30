import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { gitLogger } from "./logging";
import { getMountStatus } from "./mount-manager";
import { fetchRepo, hasUncommittedChanges, isMergeConflict } from "./git-ops";

export interface SyncStatus {
  remoteName: string;
  branch: string;
  localAhead: number;
  localBehind: number;
  hasUncommittedChanges: boolean;
  conflict: boolean | null;
  lastFetched: string | null;
  lastSynced: string | null;
}

function getRepoPath(remoteName: string): string {
  return path.join(dataDir(), ".git-cache", remoteName);
}

function runGit(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      resolve({ stdout: "", stderr: "spawn failed", exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 });
    });
  });
}

export async function getSyncStatus(remoteName: string): Promise<SyncStatus> {
  const op = "sync-status.getSyncStatus";
  const mount = getMountStatus(remoteName);
  if (!mount) {
    gitLogger().error({
      op,
      remote: remoteName,
      error: { code: "NOT_FOUND", message: `Remote "${remoteName}" is not mounted` },
    });
    throw new Error(`Remote "${remoteName}" is not mounted`);
  }

  const repoPath = getRepoPath(remoteName);
  let localAhead = 0;
  let localBehind = 0;
  let lastFetched: string | null = null;

  try {
    const ab = await fetchRepo(repoPath, "origin", mount.branch);
    localAhead = ab.ahead;
    localBehind = ab.behind;
    lastFetched = new Date().toISOString();
  } catch {
    gitLogger().warn({ op, remote: remoteName, error: { code: "FETCH_FAILED", message: "Fetch failed during sync status check" } });
  }

  let uncommitted = false;
  try {
    uncommitted = await hasUncommittedChanges(repoPath);
  } catch {
    // If we can't check (e.g. not a git repo), assume no changes.
  }

  const status: SyncStatus = {
    remoteName,
    branch: mount.branch,
    localAhead,
    localBehind,
    hasUncommittedChanges: uncommitted,
    conflict: null,
    lastFetched,
    lastSynced: mount.lastSynced ?? null,
  };

  gitLogger().info({ op, remote: remoteName });
  return status;
}

export async function hasConflict(remoteName: string): Promise<boolean> {
  const op = "sync-status.hasConflict";
  const repoPath = getRepoPath(remoteName);
  const mount = getMountStatus(remoteName);
  if (!mount) {
    gitLogger().error({
      op,
      remote: remoteName,
      error: { code: "NOT_FOUND", message: `Remote "${remoteName}" is not mounted` },
    });
    throw new Error(`Remote "${remoteName}" is not mounted`);
  }

  try {
    // Dry-run merge to detect conflicts without modifying working tree.
    const { exitCode } = await runGit(
      ["merge", "--no-commit", "--no-ff", `origin/${mount.branch}`],
      { cwd: repoPath },
    );

    if (exitCode !== 0) {
      // Abort the merge attempt.
      await runGit(["merge", "--abort"], { cwd: repoPath });
      gitLogger().info({ op, remote: remoteName });
      return true;
    }

    // Clean up the merge attempt.
    await runGit(["merge", "--abort"], { cwd: repoPath });
    gitLogger().info({ op, remote: remoteName });
    return false;
  } catch {
    gitLogger().warn({ op, remote: remoteName, error: { code: "CHECK_FAILED", message: "Conflict check failed" } });
    return false;
  }
}

/** The working context for a VFS-mounted repo, so a conflict here escalates
 *  through the SAME mechanism as every other repo (FR-003/FR-004, S6). */
export function mountWorkContext(remoteName: string): { repoPath: string; branch: string } | null {
  const mount = getMountStatus(remoteName);
  if (!mount) return null;
  return { repoPath: getRepoPath(remoteName), branch: mount.branch };
}

/**
 * Reconcile a mounted repo against its remote with the chosen strategy.
 *
 * 035 (FR-016): a CONFLICT is no longer a thrown dead-end. It is reported as
 * `{ status: "conflict" }` so the caller can route it through the shared
 * pipeline with this mount's working context — the same session + agent + pane
 * every other repo gets. A genuine failure (not a conflict) still throws.
 */
export async function resolveConflict(
  remoteName: string,
  strategy: "merge" | "rebase",
): Promise<{ status: "success" | "conflict" }> {
  const op = "sync-status.resolveConflict";
  const repoPath = getRepoPath(remoteName);
  const mount = getMountStatus(remoteName);
  if (!mount) {
    gitLogger().error({
      op,
      remote: remoteName,
      error: { code: "NOT_FOUND", message: `Remote "${remoteName}" is not mounted` },
    });
    throw new Error(`Remote "${remoteName}" is not mounted`);
  }

  const t0 = Date.now();

  if (strategy === "rebase") {
    const { exitCode, stderr } = await runGit(
      ["rebase", `origin/${mount.branch}`],
      { cwd: repoPath },
    );
    if (exitCode !== 0) {
      await runGit(["rebase", "--abort"], { cwd: repoPath });
      const durationMs = Date.now() - t0;
      if (isMergeConflict(stderr)) {
        gitLogger().warn({ op, remote: remoteName, durationMs, error: { code: "REBASE_CONFLICT", message: stderr } });
        return { status: "conflict" };
      }
      gitLogger().error({
        op,
        remote: remoteName,
        durationMs,
        success: false,
        error: { code: "REBASE_FAILED", message: stderr },
      });
      throw new Error(`Rebase failed: ${stderr}`);
    }
  } else {
    const { exitCode, stderr } = await runGit(
      ["merge", `origin/${mount.branch}`],
      { cwd: repoPath },
    );
    if (exitCode !== 0) {
      const durationMs = Date.now() - t0;
      if (isMergeConflict(stderr)) {
        await runGit(["merge", "--abort"], { cwd: repoPath });
        gitLogger().warn({ op, remote: remoteName, durationMs, error: { code: "MERGE_CONFLICT", message: stderr } });
        return { status: "conflict" };
      }
      gitLogger().error({
        op,
        remote: remoteName,
        durationMs,
        success: false,
        error: { code: "MERGE_FAILED", message: stderr },
      });
      throw new Error(`Merge failed: ${stderr}`);
    }
  }

  const durationMs = Date.now() - t0;
  gitLogger().info({ op, remote: remoteName, durationMs, success: true });
  return { status: "success" };
}

// Export helpers for testing.
export { getRepoPath as _getRepoPath };
