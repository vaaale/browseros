import "server-only";
import { spawn } from "node:child_process";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";
import { resolveAuth, type AuthType, type GitAuth } from "@/lib/gitops/auth";
import { fetchRepo, type GitError } from "@/lib/gitops/git-ops";
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

interface RefSnapshot {
  [ref: string]: string;
}

async function getRemoteRefs(repoPath: string, remote: string): Promise<RefSnapshot> {
  const child = spawn("git", ["ls-remote", "--heads", remote], {
    cwd: repoPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

  return new Promise<RefSnapshot>((resolve) => {
    child.on("close", () => {
      const refs: RefSnapshot = {};
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\S+)\s+(refs\/heads\/.+)/);
        if (match) refs[match[2]] = match[1];
      }
      resolve(refs);
    });
    child.on("error", () => resolve({}));
  });
}

function diffRefs(before: RefSnapshot, after: RefSnapshot): {
  newBranches: string[];
  updatedBranches: string[];
  deletedBranches: string[];
} {
  const newBranches: string[] = [];
  const updatedBranches: string[] = [];
  const deletedBranches: string[] = [];

  for (const [ref, hash] of Object.entries(after)) {
    const branch = ref.replace("refs/heads/", "");
    if (!before[ref]) {
      newBranches.push(branch);
    } else if (before[ref] !== hash) {
      updatedBranches.push(branch);
    }
  }

  for (const ref of Object.keys(before)) {
    if (!after[ref]) {
      deletedBranches.push(ref.replace("refs/heads/", ""));
    }
  }

  return { newBranches, updatedBranches, deletedBranches };
}

export function gitFetchTools(): Record<string, AssistantTool> {
  return {
    git_fetch: serverTool(
      "git_fetch",
      "Fetch updates from remotes. Acquires the git lock, resolves authentication, fetches, detects branch changes (new/updated/deleted), and records the fetch timestamp in remote-config.json.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          remote: p.str("Remote name to fetch from (defaults to 'origin'). Use '*' to fetch all remotes."),
          authType: p.str("Optional auth type override: 'token', 'oauth', or 'ssh' (otherwise resolved from secrets store)"),
          token: p.str("Optional inline credential (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const remote = input.remote != null ? String(input.remote).trim() : "origin";
        const authType = input.authType != null ? String(input.authType).trim() : undefined;
        const token = input.token != null ? String(input.token) : undefined;

        if (!repoPath) {
          return err("MISSING_PARAMS", "repoPath is required.");
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_fetch", async (release) => {
          try {
            const auth = await buildAuth(remote, authType, token) ?? undefined;

            // Snapshot refs before fetch for change detection.
            const before = await getRemoteRefs(repoPath, remote);

            const aheadBehind = await fetchRepo(repoPath, remote, undefined, auth);

            // Snapshot refs after fetch.
            const after = await getRemoteRefs(repoPath, remote);

            const updates = [diffRefs(before, after)];

            // Update lastFetched for the remote in remote-config.json.
            updateRemoteConfig(remote, { lastFetched: new Date().toISOString() });

            gitLogger().info({ op: "tool.git_fetch", repoPath, remote, success: true });

            return JSON.stringify({
              status: "success",
              updates,
              aheadBehind,
            });
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_FETCH_FAILED";
            const message = gitErr.message ?? (e as Error).message;
            gitLogger().error({ op: "tool.git_fetch", repoPath, remote, error: { code, message } });
            return JSON.stringify({ status: "failed", updates: [], error: { code, message } });
          } finally {
            await release();
          }
        });
      },
    ),
  };
}
