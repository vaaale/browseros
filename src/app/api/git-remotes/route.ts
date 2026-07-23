import { NextRequest, NextResponse } from "next/server";
import { readRemoteConfigs, addRemoteConfig, updateRemoteConfig, removeRemoteConfig } from "@/lib/gitops/remote-config";
import { addRemote, removeRemote, listRemotes, fetchRepo, pushRepo, testConnection } from "@/lib/gitops/git-ops";
import { resolveAuth, validateAuth, type AuthType } from "@/lib/gitops/auth";
import { getSecretsStore } from "@/lib/integrations/secrets/store";
import { gitLock } from "@/lib/gitops/lock";
import { gitLogger } from "@/lib/gitops/logging";

export const dynamic = "force-dynamic";

const REPO_PATH = process.cwd();

function err(code: string, message: string, suggestion?: string) {
  return NextResponse.json({ error: { code, message, suggestion } }, { status: 400 });
}

export async function GET() {
  try {
    const configs = readRemoteConfigs();

    const gitRemotes = await listRemotes(REPO_PATH);
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
        inGitConfig: inGit,
        status: inGit ? "connected" : "not-in-git",
      };
    });

    for (const gitRemote of gitRemotes) {
      if (!configs.find((c) => c.name === gitRemote.name)) {
        remotes.push({
          name: gitRemote.name,
          url: gitRemote.url,
          provider: "generic" as const,
          autoPush: false,
          inGitConfig: true,
          status: "no-config",
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
        return await lock.withLock(REPO_PATH, "api.git_add_remote", async (release) => {
          try {
            const uniqueName = getUniqueRemoteName(name);
            await addRemote(REPO_PATH, uniqueName, url);

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

            const detectedProvider = provider || detectProvider(url);
            addRemoteConfig({
              name: uniqueName,
              url,
              provider: detectedProvider as "github" | "gitlab" | "generic",
              autoPush: autoPush === true,
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
            gitLogger().error({ op: "api.git_add_remote", remote: name, error: (e as Error).message });
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
        return await lock.withLock(REPO_PATH, "api.git_remove_remote", async (release) => {
          try {
            await removeRemote(REPO_PATH, name);
            removeRemoteConfig(name);

            const store = getSecretsStore();
            for (const authType of ["token", "oauth", "ssh"]) {
              await store.delete("git_remote", `git_remote:${name}:${authType}`).catch(() => {});
            }

            gitLogger().info({ op: "api.git_remove_remote", remote: name, success: true });
            return NextResponse.json({ ok: true, message: `Remote '${name}' removed.` });
          } catch (e) {
            gitLogger().error({ op: "api.git_remove_remote", remote: name, error: (e as Error).message });
            return err("GIT_REMOVE_REMOTE_FAILED", (e as Error).message);
          } finally {
            await release();
          }
        });
      }

      case "update": {
        const { name, patch } = body;
        if (!name || !patch) return err("MISSING_PARAMS", "name and patch are required.");
        const updated = updateRemoteConfig(name, patch);
        if (!updated) return err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`);
        return NextResponse.json({ ok: true, remote: updated });
      }

      case "push": {
        const { name, branch } = body;
        if (!name) return err("MISSING_PARAMS", "name is required.");

        const configs = readRemoteConfigs();
        const config = configs.find((c) => c.name === name);
        if (!config) return err("REMOTE_NOT_FOUND", `Remote '${name}' not found.`);

        const auth = await resolveAuth(name, (config as { authType?: string }).authType as AuthType ?? "token");
        const currentBranch = branch || (await import("@/lib/gitops/git-ops")).getCurrentBranch(REPO_PATH);

        const lock = gitLock();
        return await lock.withLock(REPO_PATH, "api.git_push", async (release) => {
          try {
            await pushRepo(REPO_PATH, name, currentBranch, auth ?? undefined);
            updateRemoteConfig(name, { lastPushed: new Date().toISOString() });
            gitLogger().info({ op: "api.git_push", remote: name, success: true });
            return NextResponse.json({ ok: true, message: `Pushed to '${name}/${currentBranch}'.` });
          } catch (e) {
            gitLogger().error({ op: "api.git_push", remote: name, error: (e as Error).message });
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

        const auth = await resolveAuth(name, (config as { authType?: string }).authType as AuthType ?? "token");

        const lock = gitLock();
        return await lock.withLock(REPO_PATH, "api.git_fetch", async (release) => {
          try {
            const ab = await fetchRepo(REPO_PATH, name, undefined, auth ?? undefined);
            updateRemoteConfig(name, { lastFetched: new Date().toISOString() });
            gitLogger().info({ op: "api.git_fetch", remote: name, success: true });
            return NextResponse.json({ ok: true, ahead: ab.ahead, behind: ab.behind });
          } catch (e) {
            gitLogger().error({ op: "api.git_fetch", remote: name, error: (e as Error).message });
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

        const auth = await resolveAuth(name, (config as { authType?: string }).authType as AuthType ?? "token");
        const result = await testConnection(config.url, auth ?? undefined);

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

function detectProvider(url: string): "github" | "gitlab" | "generic" {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  return "generic";
}

function getUniqueRemoteName(name: string): string {
  const configs = readRemoteConfigs();
  if (!configs.find((c) => c.name === name)) return name;
  let counter = 2;
  while (configs.find((c) => c.name === `${name}-${counter}`)) {
    counter++;
  }
  return `${name}-${counter}`;
}
