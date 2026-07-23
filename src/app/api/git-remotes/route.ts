import { NextRequest, NextResponse } from "next/server";
import { readRemoteConfigs, addRemoteConfig, updateRemoteConfig, removeRemoteConfig, getUniqueRemoteName } from "@/lib/gitops/remote-config";
import { addRemote, removeRemote, listRemotes, fetchRepo, pushRepo, testConnection, setRemoteUrl, renameRemote } from "@/lib/gitops/git-ops";
import { resolveAuth, type AuthType } from "@/lib/gitops/auth";
import {
  setRemoteToken,
  setRemoteSshKey,
  deleteRemoteCredentials,
  renameRemoteCredentials,
} from "@/lib/gitops/git-credential-helper";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";
import { getGitFsInstance, SOURCE_FS_ID } from "@/lib/gitops/filesystems";

export const dynamic = "force-dynamic";

const REPO_PATH = process.cwd();

function err(code: string, message: string, suggestion?: string) {
  return NextResponse.json({ error: { code, message, suggestion } }, { status: 400 });
}

// Resolve the git repository a request targets. `filesystem` names a GitFS
// instance (see filesystems.ts); when absent we operate on the BrowserOS source
// repo, preserving the pre-filesystem behaviour used by the assistant tools.
async function resolveRepoPath(filesystem?: string | null): Promise<string> {
  if (!filesystem) return REPO_PATH;
  const instance = await getGitFsInstance(filesystem);
  return instance?.root ?? REPO_PATH;
}

// Whether a config belongs to the given filesystem. Legacy configs (no tag)
// belong to the BrowserOS source instance.
function belongsToFilesystem(configFs: string | undefined, filesystem: string): boolean {
  return (configFs ?? SOURCE_FS_ID) === filesystem;
}

export async function GET(req: NextRequest) {
  try {
    const filesystem = new URL(req.url).searchParams.get("filesystem");
    const repoPath = await resolveRepoPath(filesystem);

    const allConfigs = readRemoteConfigs();
    const configs = filesystem
      ? allConfigs.filter((c) => belongsToFilesystem(c.filesystem, filesystem))
      : allConfigs;

    const gitRemotes = await listRemotes(repoPath).catch(() => []);
    const gitNames = new Set(gitRemotes.map((r) => r.name));

    const remotes = configs.map((config) => {
      const inGit = gitNames.has(config.name);
      return {
        name: config.name,
        url: config.url,
        provider: config.provider,
        autoPush: config.autoPush,
        defaultBranch: config.defaultBranch,
        lastFetched: config.lastFetched,
        lastPushed: config.lastPushed,
        filesystem: config.filesystem ?? SOURCE_FS_ID,
        inGitConfig: inGit,
        status: config.lastStatus ?? (inGit ? "connected" : "disconnected"),
        lastError: config.lastError,
      };
    });

    // Remotes present in the git repo but not tracked in the config store.
    for (const gitRemote of gitRemotes) {
      if (!configs.find((c) => c.name === gitRemote.name)) {
        remotes.push({
          name: gitRemote.name,
          url: gitRemote.url,
          provider: "generic" as const,
          autoPush: false,
          filesystem: filesystem ?? SOURCE_FS_ID,
          inGitConfig: true,
          status: "connected",
          defaultBranch: undefined,
          lastFetched: undefined,
          lastPushed: undefined,
          lastError: undefined,
        });
      }
    }

    return NextResponse.json({ remotes });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action ?? "");
    const filesystem: string | undefined = body.filesystem ? String(body.filesystem) : undefined;
    const repoPath = await resolveRepoPath(filesystem);

    switch (action) {
      case "add": {
        const { name, url, provider, authType, token, autoPush } = body;
        if (!name || !url || !authType) {
          return err("MISSING_PARAMS", "name, url, and authType are required.");
        }
        if (url.startsWith("git://")) {
          return err("INVALID_URL", "git:// protocol is not supported. Use https:// or ssh:// instead.");
        }
        if (!["token", "oauth", "ssh"].includes(authType)) {
          return err("INVALID_AUTH_TYPE", `Invalid authType '${authType}'. Must be 'token', 'oauth', or 'ssh'.`);
        }

        const lock = gitLock();
        return await lock.withLock(repoPath, "api.git_add_remote", async (release) => {
          try {
            const uniqueName = getUniqueRemoteName(name, filesystem ?? SOURCE_FS_ID);
            await addRemote(repoPath, uniqueName, url);

            // OAuth credentials are provider-wide and stored by the OAuth
            // callback, not here. Only per-remote token/ssh secrets (when the
            // caller supplied one) are persisted at add time.
            if (token) {
              if (authType === "ssh") await setRemoteSshKey(uniqueName, token);
              else if (authType === "token") await setRemoteToken(uniqueName, token);
            }

            const detectedProvider = provider || detectProvider(url);
            addRemoteConfig({
              name: uniqueName,
              url,
              provider: detectedProvider as "github" | "gitlab" | "generic",
              authType: authType as AuthType,
              autoPush: autoPush === true,
              defaultBranch: body.defaultBranch ? String(body.defaultBranch) : undefined,
              filesystem: filesystem ?? SOURCE_FS_ID,
            });

            gitLogger().info({ op: "api.git_add_remote", remote: uniqueName, success: true });
            return NextResponse.json({
              ok: true,
              name: uniqueName,
              url,
              provider: detectedProvider,
              message: uniqueName !== name
                ? `Remote '${name}' was already taken. Registered as '${uniqueName}' instead.`
                : `Remote '${uniqueName}' registered.`,
            });
          } catch (e) {
            gitLogger().error({ op: "api.git_add_remote", remote: name, error: { code: "GIT_ADD_REMOTE_FAILED", message: (e as Error).message } });
            return err("GIT_ADD_REMOTE_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "remove": {
        const { name } = body;
        if (!name) return err("MISSING_PARAMS", "name is required.");

        const lock = gitLock();
        return await lock.withLock(repoPath, "api.git_remove_remote", async (release) => {
          try {
            await removeRemote(repoPath, name).catch(() => {});
            removeRemoteConfig(name);

            // Provider-wide OAuth tokens are shared, so removing one remote must
            // not drop them; only per-remote token/ssh secrets are cleared.
            await deleteRemoteCredentials(name);

            gitLogger().info({ op: "api.git_remove_remote", remote: name, success: true });
            return NextResponse.json({ ok: true, message: `Remote '${name}' removed.` });
          } catch (e) {
            gitLogger().error({ op: "api.git_remove_remote", remote: name, error: { code: "GIT_REMOVE_REMOTE_FAILED", message: (e as Error).message } });
            return err("GIT_REMOVE_REMOTE_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "update": {
        const { name, patch } = body;
        if (!name || !patch || typeof patch !== "object") {
          return err("MISSING_PARAMS", "name and patch are required.");
        }

        const configs = readRemoteConfigs();
        const existing = configs.find((c) => c.name === name);
        if (!existing) return err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`);

        const newName = typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : name;
        const newUrl = typeof patch.url === "string" && patch.url.trim() ? patch.url.trim() : existing.url;

        if (newUrl.startsWith("git://")) {
          return err("INVALID_URL", "git:// protocol is not supported. Use https:// or ssh:// instead.");
        }
        if (newName !== name && configs.some((c) => c.name === newName)) {
          return err("NAME_TAKEN", `A remote named '${newName}' already exists.`);
        }

        const lock = gitLock();
        return await lock.withLock(repoPath, "api.git_update_remote", async (release) => {
          try {
            const inGit = (await listRemotes(repoPath).catch(() => [])).some((r) => r.name === name);

            if (newUrl !== existing.url && inGit) {
              await setRemoteUrl(repoPath, name, newUrl);
            }
            if (newName !== name) {
              if (inGit) await renameRemote(repoPath, name, newName);
              // Migrate per-remote token/ssh secrets to the new name. OAuth
              // tokens are provider-scoped and need no migration.
              await renameRemoteCredentials(name, newName);
            }

            const finalPatch: Record<string, unknown> = {
              name: newName,
              url: newUrl,
            };
            if (patch.provider) finalPatch.provider = patch.provider;
            if (patch.defaultBranch !== undefined) finalPatch.defaultBranch = patch.defaultBranch || undefined;
            if (patch.autoPush !== undefined) finalPatch.autoPush = patch.autoPush === true;

            const updated = updateRemoteConfig(name, finalPatch);
            gitLogger().info({ op: "api.git_update_remote", remote: newName, success: true });
            return NextResponse.json({ ok: true, remote: updated, message: `Remote '${newName}' updated.` });
          } catch (e) {
            gitLogger().error({ op: "api.git_update_remote", remote: name, error: { code: "GIT_UPDATE_REMOTE_FAILED", message: (e as Error).message } });
            return err("GIT_UPDATE_REMOTE_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "push": {
        const { name, branch } = body;
        if (!name) return err("MISSING_PARAMS", "name is required.");

        const configs = readRemoteConfigs();
        const config = configs.find((c) => c.name === name);
        if (!config) return err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`);

        const auth = await resolveAuth(name, authTypeFor(config), config.provider);
        const currentBranch = branch || config.defaultBranch || (await import("@/lib/gitops/git-ops")).getCurrentBranch(repoPath);

        const lock = gitLock();
        return await lock.withLock(repoPath, "api.git_push", async (release) => {
          try {
            await pushRepo(repoPath, name, await currentBranch, auth ?? undefined);
            updateRemoteConfig(name, { lastPushed: new Date().toISOString(), lastStatus: "connected", lastError: undefined });
            gitLogger().info({ op: "api.git_push", remote: name, success: true });
            return NextResponse.json({ ok: true, message: `Pushed to '${name}/${await currentBranch}'.` });
          } catch (e) {
            updateRemoteConfig(name, { lastStatus: "error", lastError: (e as Error).message });
            gitLogger().error({ op: "api.git_push", remote: name, error: { code: "GIT_PUSH_FAILED", message: (e as Error).message } });
            return err("GIT_PUSH_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "fetch": {
        const { name } = body;
        if (!name) return err("MISSING_PARAMS", "name is required.");

        const configs = readRemoteConfigs();
        const config = configs.find((c) => c.name === name);
        if (!config) return err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`);

        const auth = await resolveAuth(name, authTypeFor(config), config.provider);

        const lock = gitLock();
        return await lock.withLock(repoPath, "api.git_fetch", async (release) => {
          try {
            const ab = await fetchRepo(repoPath, name, config.defaultBranch, auth ?? undefined);
            updateRemoteConfig(name, { lastFetched: new Date().toISOString(), lastStatus: "connected", lastError: undefined });
            gitLogger().info({ op: "api.git_fetch", remote: name, success: true });
            return NextResponse.json({ ok: true, ahead: ab.ahead, behind: ab.behind });
          } catch (e) {
            updateRemoteConfig(name, { lastStatus: "error", lastError: (e as Error).message });
            gitLogger().error({ op: "api.git_fetch", remote: name, error: { code: "GIT_FETCH_FAILED", message: (e as Error).message } });
            return err("GIT_FETCH_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "test": {
        const { name } = body;
        if (!name) return err("MISSING_PARAMS", "name is required.");

        const configs = readRemoteConfigs();
        const config = configs.find((c) => c.name === name);
        if (!config) return err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`);

        const auth = await resolveAuth(name, authTypeFor(config), config.provider);
        const result = await testConnection(config.url, auth ?? undefined);

        updateRemoteConfig(name, {
          lastStatus: result.ok ? "connected" : "error",
          lastError: result.ok ? undefined : result.error,
        });

        return NextResponse.json({
          ok: result.ok,
          branches: result.branches,
          error: result.error,
        });
      }

      default:
        return err("UNKNOWN_ACTION", `Unknown action '${action}'.`);
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// The credential a remote uses. Persisted on the config since 018; legacy
// remotes without it fall back to the provider default (github/gitlab connect
// via provider-wide OAuth, everything else via a per-remote token).
function authTypeFor(config: { authType?: string; provider?: string }): AuthType {
  if (config.authType) return config.authType as AuthType;
  return config.provider === "github" || config.provider === "gitlab" ? "oauth" : "token";
}

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}
