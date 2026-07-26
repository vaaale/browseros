import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";
import { resolveAuth, type AuthType, type GitAuth } from "@/lib/gitops/auth";
import { pushRepo, listRemotes, getCurrentBranch, type GitError } from "@/lib/gitops/git-ops";
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
  // Try stored credentials for each common auth type.
  for (const at of ["token", "oauth", "ssh"] as AuthType[]) {
    const auth = await resolveAuth(remoteName, at);
    if (auth) return auth;
  }
  return null;
}

export function gitPushTools(): Record<string, AssistantTool> {
  return {
    git_push: serverTool(
      "git_push",
      "Push a local branch to a single remote. Acquires the git lock, resolves authentication, pushes, and records the push timestamp in remote-config.json.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          remote: p.str("Name of the remote to push to (e.g. 'origin')"),
          branch: p.str("Branch to push (defaults to current branch)"),
          authType: p.str("Optional auth type override: 'token', 'oauth', or 'ssh' (otherwise resolved from secrets store)"),
          token: p.str("Optional inline credential (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath", "remote"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const remote = String(input.remote ?? "").trim();
        const branch = input.branch != null ? String(input.branch).trim() : undefined;
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;

        if (!repoPath || !remote) {
          return err("MISSING_PARAMS", "repoPath and remote are required.");
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_push", async (release) => {
          try {
            const targetBranch = branch ?? await getCurrentBranch(repoPath);
            const auth = await buildAuth(remote, authType, token) ?? undefined;

            await pushRepo(repoPath, remote, targetBranch, auth);

            updateRemoteConfig(remote, { lastPushed: new Date().toISOString() });

            gitLogger().info({ op: "tool.git_push", repoPath, remote, success: true });

            return JSON.stringify({ status: "success", pushed: true });
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_PUSH_FAILED";
            const message = gitErr.message ?? (e as Error).message;
            gitLogger().error({ op: "tool.git_push", repoPath, remote, error: { code, message } });
            return JSON.stringify({ status: "failed", pushed: false, error: { code, message } });
          } finally {
            await release();
          }
        });
      },
    ),

    git_push_all_remotes: serverTool(
      "git_push_all_remotes",
      "Push the current branch to all remotes (or a selected subset). Acquires a single git lock and serialises pushes across remotes. Returns a summary of results for each remote.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          branch: p.str("Branch to push (defaults to current branch)"),
          remotes: p.strArr("Optional list of remote names to push to (defaults to all remotes)"),
          authType: p.str("Optional auth type override: 'token', 'oauth', or 'ssh' (otherwise resolved per-remote from secrets store)"),
          token: p.str("Optional inline credential (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const branch = input.branch != null ? String(input.branch).trim() : undefined;
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;
        const selectedRemotes = Array.isArray(input.remotes)
          ? input.remotes.map(String).map((s) => s.trim()).filter(Boolean)
          : undefined;

        if (!repoPath) {
          return err("MISSING_PARAMS", "repoPath is required.");
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_push_all_remotes", async (release) => {
          try {
            const targetBranch = branch ?? await getCurrentBranch(repoPath);
            const allRemotes = await listRemotes(repoPath);
            const remotesToPush = selectedRemotes
              ? allRemotes.filter((r) => selectedRemotes.includes(r.name))
              : allRemotes;

            const results: Array<{ remoteName: string; status: "success" | "failed"; pushed?: boolean; error?: { code: string; message: string } }> = [];

            for (const remote of remotesToPush) {
              try {
                const auth = await buildAuth(remote.name, authType, token) ?? undefined;
                await pushRepo(repoPath, remote.name, targetBranch, auth);
                updateRemoteConfig(remote.name, { lastPushed: new Date().toISOString() });
                results.push({ remoteName: remote.name, status: "success", pushed: true });
              } catch (e) {
                const gitErr = e as GitError;
                const code = gitErr.code ?? "GIT_PUSH_FAILED";
                const message = gitErr.message ?? (e as Error).message;
                results.push({ remoteName: remote.name, status: "failed", error: { code, message } });
              }
            }

            gitLogger().info({ op: "tool.git_push_all_remotes", repoPath, success: true });

            return JSON.stringify({ results });
          } finally {
            await release();
          }
        });
      },
    ),
  };
}
