import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";
import { resolveAuth, type AuthType, type GitAuth } from "@/lib/gitops/auth";
import {
  fetchRepo,
  mergeBranch,
  getCurrentBranch,
  hasUncommittedChanges,
  type GitError,
  type MergeStrategy,
} from "@/lib/gitops/git-ops";
import { updateRemoteConfig } from "@/lib/gitops/remote-config";

function err(code: string, message: string, suggestion?: string): string {
  return JSON.stringify({ error: { code, message, suggestion } });
}

async function buildAuth(
  remoteName: string,
  authType?: string,
  token?: string,
): Promise<GitAuth | null> {
  if (authType && token) {
    const at = authType as AuthType;
    if (at === "ssh") return { type: at, sshKeyData: token };
    if (at === "oauth") return { type: at, accessToken: token };
    return { type: at, pat: token };
  }
  for (const at of ["token", "oauth", "ssh"] as AuthType[]) {
    const auth = await resolveAuth(remoteName, at);
    if (auth) return auth;
  }
  return null;
}

async function getConflictingFiles(repoPath: string): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  return new Promise<string[]>((resolve) => {
    const child = spawn("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      resolve(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
    });
    child.on("error", () => resolve([]));
  });
}

export function gitMergeTools(): Record<string, AssistantTool> {
  return {
    git_merge: serverTool(
      "git_merge",
      "Resolve branch conflicts by merging a remote branch. Supports three strategies: 'merge-squash' (squashes remote commits), 'merge' (standard merge commit), 'commit' (stashes local, commits remote, pops stash). CRITICAL: If confirm is not true, returns cancelled immediately without doing anything.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          remote: p.str("Remote name to merge from (e.g. 'origin')"),
          branch: p.str("Branch name to merge"),
          strategy: p.str("Merge strategy: 'merge-squash', 'merge', or 'commit'"),
          confirm: p.bool("Must be true to execute the merge. If false, returns cancelled."),
          authType: p.str("Optional auth type override: 'token', 'oauth', or 'ssh'"),
          token: p.str("Optional inline credential (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath", "remote", "branch", "strategy", "confirm"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const remote = String(input.remote ?? "").trim();
        const branch = String(input.branch ?? "").trim();
        const strategy = String(input.strategy ?? "").trim() as MergeStrategy;
        const confirm = input.confirm === true;
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;

        if (!confirm) {
          return JSON.stringify({ status: "cancelled" });
        }

        if (!repoPath || !remote || !branch) {
          return err("MISSING_PARAMS", "repoPath, remote, and branch are required.");
        }

        if (!["merge-squash", "merge", "commit"].includes(strategy)) {
          return err(
            "INVALID_STRATEGY",
            `Invalid strategy "${strategy}". Must be "merge-squash", "merge", or "commit".`,
          );
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_merge", async (release) => {
          try {
            const auth = (await buildAuth(remote, authType, token)) ?? undefined;

            await fetchRepo(repoPath, remote, branch, auth);

            const hasLocalChanges = await hasUncommittedChanges(repoPath);

            const result = await mergeBranch(repoPath, remote, branch, strategy);

            updateRemoteConfig(remote, { lastFetched: new Date().toISOString() });

            gitLogger().info({
              op: "tool.git_merge",
              repoPath,
              remote,
              success: true,
            });

            return JSON.stringify({
              status: "success",
              strategy,
              commitHash: result.commitHash,
              hasLocalChanges,
            });
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_MERGE_FAILED";
            const message = gitErr.message ?? (e as Error).message;

            if (code === "MERGE_CONFLICT") {
              const conflictingFiles = await getConflictingFiles(repoPath);
              return JSON.stringify({
                status: "failed",
                error: {
                  code: "MERGE_CONFLICT",
                  message,
                  suggestion:
                    "Use the ConflictResolutionDialog to resolve conflicts, or try a different merge strategy.",
                },
                conflictingFiles,
              });
            }

            gitLogger().error({
              op: "tool.git_merge",
              repoPath,
              remote,
              error: { code, message },
            });
            return JSON.stringify({ status: "failed", error: { code, message } });
          } finally {
            await release();
          }
        });
      },
    ),

    git_sync: serverTool(
      "git_sync",
      "Fetch updates from a remote branch and detect diverged state. If diverged, returns conflict_detected status with ahead/behind counts. If a conflictStrategy is provided, auto-resolves the conflict.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          remote: p.str("Remote name to sync from (e.g. 'origin')"),
          branch: p.str("Branch name to sync"),
          conflictStrategy: p.str(
            "Auto-resolve strategy when diverged: 'merge-squash', 'merge', 'commit', or 'abort'. Omit to just detect.",
          ),
          authType: p.str("Optional auth type override: 'token', 'oauth', or 'ssh'"),
          token: p.str("Optional inline credential (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath", "remote", "branch"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const remote = String(input.remote ?? "").trim();
        const branch = String(input.branch ?? "").trim();
        const conflictStrategy = input.conflictStrategy != null
          ? String(input.conflictStrategy).trim()
          : undefined;
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;

        if (!repoPath || !remote || !branch) {
          return err("MISSING_PARAMS", "repoPath, remote, and branch are required.");
        }

        if (
          conflictStrategy &&
          !["merge-squash", "merge", "commit", "abort"].includes(conflictStrategy)
        ) {
          return err(
            "INVALID_STRATEGY",
            `Invalid conflictStrategy "${conflictStrategy}". Must be "merge-squash", "merge", "commit", or "abort".`,
          );
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_sync", async (release) => {
          try {
            const auth = (await buildAuth(remote, authType, token)) ?? undefined;

            const aheadBehind = await fetchRepo(repoPath, remote, branch, auth);

            const currentBranch = await getCurrentBranch(repoPath);
            const hasLocalChanges = await hasUncommittedChanges(repoPath);

            const diverged = aheadBehind.ahead > 0 && aheadBehind.behind > 0;
            const inSync = aheadBehind.ahead === 0 && aheadBehind.behind === 0;

            if (diverged && !conflictStrategy) {
              gitLogger().info({
                op: "tool.git_sync",
                repoPath,
                remote,
                success: true,
              });
              return JSON.stringify({
                status: "conflict_detected",
                branch: currentBranch,
                ahead: aheadBehind.ahead,
                behind: aheadBehind.behind,
                hasLocalChanges,
                conflict: {
                  strategy: null,
                  requiresConfirmation: true,
                },
              });
            }

            if (diverged && conflictStrategy === "abort") {
              gitLogger().info({
                op: "tool.git_sync",
                repoPath,
                remote,
                success: true,
              });
              return JSON.stringify({
                status: "aborted",
                branch: currentBranch,
                ahead: aheadBehind.ahead,
                behind: aheadBehind.behind,
                hasLocalChanges,
              });
            }

            if (diverged && conflictStrategy) {
              const result = await mergeBranch(
                repoPath,
                remote,
                branch,
                conflictStrategy as MergeStrategy,
              );

              gitLogger().info({
                op: "tool.git_sync",
                repoPath,
                remote,
                success: true,
              });

              return JSON.stringify({
                status: "resolved",
                strategy: conflictStrategy,
                commitHash: result.commitHash,
                branch: currentBranch,
                ahead: 0,
                behind: 0,
                hasLocalChanges,
              });
            }

            gitLogger().info({
              op: "tool.git_sync",
              repoPath,
              remote,
              success: true,
            });

            return JSON.stringify({
              status: inSync ? "in_sync" : "behind",
              branch: currentBranch,
              ahead: aheadBehind.ahead,
              behind: aheadBehind.behind,
              hasLocalChanges,
            });
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_SYNC_FAILED";
            const message = gitErr.message ?? (e as Error).message;

            if (code === "MERGE_CONFLICT") {
              const conflictingFiles = await getConflictingFiles(repoPath);
              return JSON.stringify({
                status: "conflict_detected",
                error: {
                  code: "MERGE_CONFLICT",
                  message,
                  suggestion:
                    "Use the ConflictResolutionDialog to resolve conflicts, or try a different conflict strategy.",
                },
                conflictingFiles,
              });
            }

            gitLogger().error({
              op: "tool.git_sync",
              repoPath,
              remote,
              error: { code, message },
            });
            return JSON.stringify({ status: "failed", error: { code, message } });
          } finally {
            await release();
          }
        });
      },
    ),
  };
}
