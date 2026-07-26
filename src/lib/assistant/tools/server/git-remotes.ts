import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";
import { type AuthType } from "@/lib/gitops/auth";
import {
  addRemote,
  removeRemote,
  listRemotes,
  listRemoteBranches,
  type GitError,
} from "@/lib/gitops/git-ops";
import {
  addRemoteConfig,
  removeRemoteConfig,
  getUniqueRemoteName,
} from "@/lib/gitops/remote-config";
import { getSecretsStore } from "@/lib/integrations/secrets/store";

function err(code: string, message: string, suggestion?: string): string {
  return JSON.stringify({ error: { code, message, suggestion } });
}

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

export function gitRemotesTools(): Record<string, AssistantTool> {
  return {
    git_add_remote: serverTool(
      "git_add_remote",
      "Register a new git remote: adds it to the local git config, stores credentials in the encrypted secrets store, and persists metadata in the remote-config file. Rejects git:// URLs. If the requested name is already taken, auto-renames it (returns uniqueName).",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          name: p.str("Short name for the remote (e.g. 'origin', 'upstream')"),
          url: p.str("Remote URL (https://, ssh://, or git@…)"),
          provider: p.str("Provider hint: 'github', 'gitlab', or 'generic' (auto-detected if omitted)"),
          authType: p.str("Auth type: 'token', 'oauth', or 'ssh'"),
          token: p.str("Optional credential to store (PAT, OAuth token, or SSH key data)"),
        },
        ["repoPath", "name", "url", "authType"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const name = String(input.name ?? "").trim();
        const url = String(input.url ?? "").trim();
        const providerHint = String(input.provider ?? "").trim();
        const authType = String(input.authType ?? "").trim() as AuthType;
        const token = input.token != null ? String(input.token) : undefined;

        if (!repoPath || !name || !url || !authType) {
          return err("MISSING_PARAMS", "repoPath, name, url, and authType are required.");
        }

        if (url.startsWith("git://")) {
          return err("INVALID_URL", "git:// protocol is not supported for remotes. Use https:// or ssh:// instead.", "Convert the URL to HTTPS or SSH format.");
        }

        if (!["token", "oauth", "ssh"].includes(authType)) {
          return err("INVALID_AUTH_TYPE", `Invalid authType '${authType}'. Must be 'token', 'oauth', or 'ssh'.`);
        }

        const lock = gitLock();
        const provider = providerHint || detectProvider(url);

        return await lock.withLock(repoPath, "git_add_remote", async (release) => {
          try {
            const uniqueName = getUniqueRemoteName(name);
            const finalUrl = uniqueName !== name ? url : url;

            await addRemote(repoPath, uniqueName, finalUrl);

            if (token) {
              const store = getSecretsStore();
              const secretKey = `git_remote:${uniqueName}:${authType}`;
              const value = authType === "ssh"
                ? { keyData: token }
                : authType === "oauth"
                  ? { access_token: token }
                  : { token };
              await store.set("git_remote", secretKey, value);
            }

            addRemoteConfig({
              name: uniqueName,
              url: finalUrl,
              provider: provider as "github" | "gitlab" | "generic",
              autoPush: false,
            });

            gitLogger().info({ op: "tool.git_add_remote", repoPath, remote: uniqueName, success: true });

            const result: Record<string, unknown> = {
              name: uniqueName,
              url: finalUrl,
              status: "ok",
              message: uniqueName !== name
                ? `Remote name '${name}' was already taken. Registered as '${uniqueName}' instead.`
                : `Remote '${uniqueName}' registered successfully.`,
            };
            if (uniqueName !== name) {
              result.uniqueName = uniqueName;
            }
            return JSON.stringify(result);
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_ADD_REMOTE_FAILED";
            const message = gitErr.message ?? (e as Error).message;
            gitLogger().error({ op: "tool.git_add_remote", repoPath, remote: name, error: { code, message } });
            return err(code, message, gitErr.suggestion);
          } finally {
            await release();
          }
        });
      },
    ),

    git_remove_remote: serverTool(
      "git_remove_remote",
      "Remove a git remote from the local git config and the remote-config metadata store. Also deletes any stored credentials for that remote.",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
          name: p.str("Name of the remote to remove"),
        },
        ["repoPath", "name"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();
        const name = String(input.name ?? "").trim();

        if (!repoPath || !name) {
          return err("MISSING_PARAMS", "repoPath and name are required.");
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_remove_remote", async (release) => {
          try {
            await removeRemote(repoPath, name);
            removeRemoteConfig(name);

            const store = getSecretsStore();
            for (const authType of ["token", "oauth", "ssh"]) {
              await store.delete("git_remote", `git_remote:${name}:${authType}`).catch(() => {});
            }

            gitLogger().info({ op: "tool.git_remove_remote", repoPath, remote: name, success: true });
            return JSON.stringify({ status: "ok", message: `Remote '${name}' removed successfully.` });
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_REMOVE_REMOTE_FAILED";
            const message = gitErr.message ?? (e as Error).message;
            gitLogger().error({ op: "tool.git_remove_remote", repoPath, remote: name, error: { code, message } });
            return err(code, message, gitErr.suggestion);
          } finally {
            await release();
          }
        });
      },
    ),

    git_list_remotes: serverTool(
      "git_list_remotes",
      "List all git remotes configured for a repository, augmented with metadata from the remote-config store (provider, autoPush, etc).",
      schema(
        {
          repoPath: p.str("Absolute path to the local git repository"),
        },
        ["repoPath"],
      ),
      async (input, _ctx) => {
        const repoPath = String(input.repoPath ?? "").trim();

        if (!repoPath) {
          return err("MISSING_PARAMS", "repoPath is required.");
        }

        const lock = gitLock();

        return await lock.withLock(repoPath, "git_list_remotes", async (release) => {
          try {
            const gitRemotes = await listRemotes(repoPath);

            // Augment with remote-config metadata.
            let configs: Array<{ name: string; url: string; provider?: string; autoPush?: boolean }> = [];
            try {
              const { readFileSync, existsSync } = await import("node:fs");
              const { join } = await import("node:path");
              const { dataDir } = await import("@/os/data-dir");
              const configPath = join(dataDir(), "config", "git-remotes.json");
              if (existsSync(configPath)) {
                configs = JSON.parse(readFileSync(configPath, "utf-8"));
              }
            } catch {
              // Config file may not exist yet — that's fine.
            }

            const configMap = new Map(configs.map((c) => [c.name, c]));

            const remotes = gitRemotes.map((r) => {
              const meta = configMap.get(r.name);
              return {
                name: r.name,
                url: r.url,
                provider: meta?.provider,
                autoPush: meta?.autoPush,
              };
            });

            gitLogger().info({ op: "tool.git_list_remotes", repoPath, success: true });
            return JSON.stringify({ remotes });
          } catch (e) {
            const gitErr = e as GitError;
            const code = gitErr.code ?? "GIT_LIST_REMOTES_FAILED";
            const message = gitErr.message ?? (e as Error).message;
            gitLogger().error({ op: "tool.git_list_remotes", repoPath, error: { code, message } });
            return err(code, message, gitErr.suggestion);
          } finally {
            await release();
          }
        });
      },
    ),

    git_list_branches: serverTool(
      "git_list_branches",
      "List all branches on a remote repository (via ls-remote). Requires the remote URL and authentication details. Does not need a local repo path.",
      schema(
        {
          url: p.str("Remote repository URL"),
          authType: p.str("Auth type: 'token', 'oauth', or 'ssh'"),
          token: p.str("Optional credential (PAT, OAuth token, or SSH key data)"),
        },
        ["url", "authType"],
      ),
      async (input, _ctx) => {
        const url = String(input.url ?? "").trim();
        const authType = String(input.authType ?? "").trim() as AuthType;
        const token = input.token != null ? String(input.token) : undefined;

        if (!url || !authType) {
          return err("MISSING_PARAMS", "url and authType are required.");
        }

        if (!["token", "oauth", "ssh"].includes(authType)) {
          return err("INVALID_AUTH_TYPE", `Invalid authType '${authType}'. Must be 'token', 'oauth', or 'ssh'.`);
        }

        try {
          const auth: import("@/lib/gitops/auth").GitAuth | null = token
            ? authType === "ssh"
              ? { type: authType, sshKeyData: token }
              : authType === "oauth"
                ? { type: authType, accessToken: token }
                : { type: authType, pat: token }
            : null;

          const branches = await listRemoteBranches(url, auth ?? undefined);

          gitLogger().info({ op: "tool.git_list_branches", remote: url, success: true });
          return JSON.stringify({ branches });
        } catch (e) {
          const gitErr = e as GitError;
          const code = gitErr.code ?? "GIT_LIST_BRANCHES_FAILED";
          const message = gitErr.message ?? (e as Error).message;
          gitLogger().error({ op: "tool.git_list_branches", remote: url, error: { code, message } });
          return err(code, message, gitErr.suggestion);
        }
      },
    ),
  };
}
