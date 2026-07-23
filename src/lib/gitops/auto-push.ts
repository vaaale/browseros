import "server-only";
import { readRemoteConfigs, type GitRemoteConfig } from "./remote-config";
import { gitLock } from "./lock";
import { resolveAuth } from "./auth";
import { pushRepo, type GitError } from "./git-ops";
import { gitLogger } from "./logging";

export interface AutoPushResult {
  remoteName: string;
  status: "success" | "failed";
  error?: { code: string; message: string };
}

export function getAutoPushRemotes(repoPath: string): GitRemoteConfig[] {
  return readRemoteConfigs().filter(
    (r) => r.autoPush && r.name !== "origin",
  );
}

export async function executeAutoPush(
  repoPath: string,
  branch: string,
): Promise<AutoPushResult[]> {
  const op = "auto-push.execute";
  const remotes = getAutoPushRemotes(repoPath);
  if (!remotes.length) {
    gitLogger().debug({ op, repoPath });
    return [];
  }

  gitLogger().info({ op, repoPath, remote: remotes.map((r) => r.name).join(",") });
  const results: AutoPushResult[] = [];

  for (const remote of remotes) {
    const release = await gitLock().acquire(repoPath, `auto-push:${remote.name}`);
    try {
      const auth = await resolveAuth(remote.name, remote.provider === "github" || remote.provider === "gitlab" ? "oauth" : "token");
      await pushRepo(repoPath, remote.name, branch, auth ?? undefined);
      results.push({ remoteName: remote.name, status: "success" });
      gitLogger().info({ op, repoPath, remote: remote.name, success: true });
    } catch (err) {
      const gitErr = err as GitError;
      results.push({
        remoteName: remote.name,
        status: "failed",
        error: { code: gitErr.code, message: gitErr.message },
      });
      gitLogger().warn({ op, repoPath, remote: remote.name, success: false, error: { code: gitErr.code, message: gitErr.message } });
    } finally {
      await release();
    }
  }

  return results;
}
