import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { gitLogger } from "@/lib/gitops/logging";
import { resolveAuth, type AuthType, type GitAuth } from "@/lib/gitops/auth";
import { fetchRepo, getCurrentBranch, hasUncommittedChanges, type MergeStrategy } from "@/lib/gitops/git-ops";
import { reconcile } from "@/lib/gitops/reconcile";
import { updateRemoteConfig } from "@/lib/gitops/remote-config";

// git_merge / git_sync — thin wrappers over the shared reconciliation
// pipeline (001-external-repo-integration, User Story 6; AD-007). No
// `confirm`/`requiresConfirmation` gate: the pipeline runs automatically
// (rollback tag → remote-sync → strategy → scripted rebase fallback →
// DevOps Agent escalation), the same as every other GitFS instance.

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

const MERGE_STRATEGIES: MergeStrategy[] = ["merge-squash", "merge", "commit"];

export function gitMergeTools(): Record<string, AssistantTool> {
  return {
    git_merge: serverTool(
      "git_merge",
      "Resolve a branch conflict by merging remote changes. Runs the shared reconciliation pipeline automatically (rollback tag, remote-sync, the requested strategy, a scripted rebase fallback on conflict, and — only if both of those fail — escalation to the DevOps Agent). No confirmation flag: this always executes.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          remote: p.str("Remote name to merge from (e.g. 'origin')"),
          branch: p.str("Branch name to merge"),
          strategy: p.str("Merge strategy: 'merge-squash', 'merge', or 'commit'"),
          authType: p.str("Optional auth type override: 'token', 'oauth', or 'ssh'"),
          token: p.str("Optional inline credential (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath", "remote", "branch", "strategy"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const remote = String(input.remote ?? "").trim();
        const branch = String(input.branch ?? "").trim();
        const strategy = String(input.strategy ?? "").trim() as MergeStrategy;
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;

        if (!repoPath || !remote || !branch) {
          return err("MISSING_PARAMS", "repoPath, remote, and branch are required.");
        }
        if (!MERGE_STRATEGIES.includes(strategy)) {
          return err("INVALID_STRATEGY", `Invalid strategy "${strategy}". Must be "merge-squash", "merge", or "commit".`);
        }

        const auth = (await buildAuth(remote, authType, token)) ?? undefined;
        gitLogger().info({ op: "tool.git_merge", repoPath, remote, success: true, error: undefined });

        const outcome = await reconcile({
          repoPath,
          remote,
          branch,
          sourceRef: `${remote}/${branch}`,
          strategy,
          auth,
        });

        if (outcome.status === "success" || outcome.status === "escalated") {
          updateRemoteConfig(remote, { lastFetched: new Date().toISOString() });
        }
        gitLogger().info({ op: "tool.git_merge", repoPath, remote, success: outcome.status !== "failed", error: outcome.error });

        return JSON.stringify({
          status: outcome.status,
          method: outcome.method,
          rollbackTag: outcome.rollbackTag,
          devopsConversationId: outcome.devopsConversationId,
          runStatus: outcome.runStatus,
          error: outcome.error,
        });
      },
    ),

    git_sync: serverTool(
      "git_sync",
      "Fetch updates from a remote branch and detect diverged state. If diverged and a conflictStrategy is provided, reconciles automatically via the shared pipeline (rollback tag, strategy, scripted rebase fallback, DevOps Agent escalation if both fail). Omit conflictStrategy to just detect and report ahead/behind.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          remote: p.str("Remote name to sync from (e.g. 'origin')"),
          branch: p.str("Branch name to sync"),
          conflictStrategy: p.str(
            "Reconciliation strategy to use if diverged: 'merge-squash', 'merge', or 'commit'. Omit to just detect and report.",
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
        const conflictStrategy = input.conflictStrategy != null ? String(input.conflictStrategy).trim() : undefined;
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;

        if (!repoPath || !remote || !branch) {
          return err("MISSING_PARAMS", "repoPath, remote, and branch are required.");
        }
        if (conflictStrategy && !MERGE_STRATEGIES.includes(conflictStrategy as MergeStrategy)) {
          return err("INVALID_STRATEGY", `Invalid conflictStrategy "${conflictStrategy}". Must be "merge-squash", "merge", or "commit".`);
        }

        const auth = (await buildAuth(remote, authType, token)) ?? undefined;

        try {
          const aheadBehind = await fetchRepo(repoPath, remote, branch, auth);
          const currentBranch = await getCurrentBranch(repoPath);
          const hasLocalChanges = await hasUncommittedChanges(repoPath);
          const diverged = aheadBehind.ahead > 0 && aheadBehind.behind > 0;
          const inSync = aheadBehind.ahead === 0 && aheadBehind.behind === 0;

          if (!diverged || !conflictStrategy) {
            gitLogger().info({ op: "tool.git_sync", repoPath, remote, success: true, error: undefined });
            return JSON.stringify({
              status: diverged ? "diverged" : inSync ? "in_sync" : "behind",
              branch: currentBranch,
              ahead: aheadBehind.ahead,
              behind: aheadBehind.behind,
              hasLocalChanges,
            });
          }

          gitLogger().info({ op: "tool.git_sync", repoPath, remote, success: true, error: undefined });
          const outcome = await reconcile({
            repoPath,
            remote,
            branch,
            sourceRef: `${remote}/${branch}`,
            strategy: conflictStrategy as MergeStrategy,
            auth,
          });

          gitLogger().info({ op: "tool.git_sync", repoPath, remote, success: outcome.status !== "failed", error: outcome.error });
          return JSON.stringify({
            status: outcome.status,
            method: outcome.method,
            branch: currentBranch,
            rollbackTag: outcome.rollbackTag,
            devopsConversationId: outcome.devopsConversationId,
            runStatus: outcome.runStatus,
            error: outcome.error,
          });
        } catch (e) {
          const message = (e as Error).message ?? String(e);
          gitLogger().error({ op: "tool.git_sync", repoPath, remote, success: false, error: { code: "GIT_SYNC_FAILED", message } });
          return err("GIT_SYNC_FAILED", message);
        }
      },
    ),
  };
}
