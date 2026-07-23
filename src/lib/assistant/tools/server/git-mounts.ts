import "server-only";
import { join } from "path";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";
import { resolveAuth, type AuthType } from "@/lib/gitops/auth";
import { cloneRepo, type GitError } from "@/lib/gitops/git-ops";
import {
  mountRepo,
  unmountRepo,
  listMounts,
  validateMountPath,
  _remoteHash,
} from "@/lib/gitops/mount-manager";
import { readRemoteConfigs } from "@/lib/gitops/remote-config";
import { dataDir } from "@/os/data-dir";

function err(code: string, message: string, suggestion?: string): string {
  return JSON.stringify({ error: { code, message, suggestion } });
}

async function buildAuth(
  remoteName: string,
  authType?: string,
  token?: string,
): Promise<import("@/lib/gitops/auth").GitAuth | null> {
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

export function gitMountTools(): Record<string, AssistantTool> {
  return {
    git_mount: serverTool(
      "git_mount",
      "Mount a configured remote repository to a VFS path. Validates the mount path, registers the mount, clones the remote into the bare cache directory, and releases the lock.",
      schema(
        {
          remoteName: p.str("Name of a configured remote (from git_add_remote)"),
          mountPath: p.str("VFS path to mount into (relative to data/vfs/)"),
          branch: p.str("Branch to track (defaults to remote's default branch)"),
        },
        ["remoteName", "mountPath"],
      ),
      async (input, _ctx) => {
        const remoteName = String(input.remoteName ?? "").trim();
        const mountPath = String(input.mountPath ?? "").trim();
        const branch = input.branch != null ? String(input.branch).trim() : undefined;

        if (!remoteName || !mountPath) {
          return err("MISSING_PARAMS", "remoteName and mountPath are required.");
        }

        if (!validateMountPath(mountPath)) {
          return err(
            "MOUNT_PATH_INVALID",
            `Mount path "${mountPath}" is outside data/vfs/.`,
            "Use a relative path within the VFS, e.g. 'Documents/my-repo'.",
          );
        }

        const configs = readRemoteConfigs();
        const remoteConfig = configs.find((c) => c.name === remoteName);
        if (!remoteConfig) {
          return err(
            "REMOTE_NOT_FOUND",
            `Remote "${remoteName}" is not configured. Use git_add_remote first.`,
          );
        }

        const cachePath = join(dataDir(), ".git-cache", _remoteHash(remoteName));

        try {
          const config = mountRepo(remoteName, mountPath, branch ?? remoteConfig.defaultBranch ?? "main");

          const lock = gitLock();

          await lock.withLock(cachePath, "git_mount", async (release) => {
            try {
              const auth = await buildAuth(remoteName) ?? undefined;
              await cloneRepo(
                remoteConfig.url,
                cachePath,
                config.branch,
                auth,
              );
            } finally {
              await release();
            }
          });

          gitLogger().info({ op: "tool.git_mount", remote: remoteName, repoPath: cachePath, success: true });

          return JSON.stringify({
            status: "success",
            mountPath: config.mountPath,
            branch: config.branch,
          });
        } catch (e) {
          const gitErr = e as GitError;
          const code = gitErr.code ?? "GIT_MOUNT_FAILED";
          const message = gitErr.message ?? (e as Error).message;
          gitLogger().error({ op: "tool.git_mount", remote: remoteName, repoPath: cachePath, error: { code, message } });
          return err(code, message, gitErr.suggestion);
        }
      },
    ),

    git_unmount: serverTool(
      "git_unmount",
      "Unmount a remote by name, removing it from the mount registry.",
      schema(
        {
          remoteName: p.str("Name of the remote to unmount"),
        },
        ["remoteName"],
      ),
      async (input, _ctx) => {
        const remoteName = String(input.remoteName ?? "").trim();

        if (!remoteName) {
          return err("MISSING_PARAMS", "remoteName is required.");
        }

        const success = unmountRepo(remoteName);
        if (!success) {
          return err("NOT_FOUND", `Remote "${remoteName}" is not mounted.`);
        }

        gitLogger().info({ op: "tool.git_unmount", remote: remoteName, success: true });

        return JSON.stringify({
          status: "ok",
          message: `Remote '${remoteName}' unmounted.`,
        });
      },
    ),

    git_list_mounts: serverTool(
      "git_list_mounts",
      "List all currently mounted remotes and their status.",
      schema(),
      async (_input, _ctx) => {
        const mounts = listMounts();
        gitLogger().info({ op: "tool.git_list_mounts", success: true });
        return JSON.stringify({ mounts });
      },
    ),
  };
}
