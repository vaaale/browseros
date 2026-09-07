import { promises as fs } from "node:fs";
import path from "node:path";
import { CANONICAL_DATA } from "./config.mjs";
import { git } from "./gitutil.mjs";
import { state } from "./state.mjs";
import { log, slog } from "./log.mjs";
import { isGitAuthFailure } from "./git-auth.mjs";
import { resolveRemoteToken, buildGitCredential } from "./secrets.mjs";

// Matches src/lib/gitops/filesystems.ts's SOURCE_FS_ID. The Supervisor is a
// separate, unbundled process with no import access to src/lib, so this is a
// literal duplicate of that constant's value, not a shared import — keep them
// in sync by hand if the source filesystem's id ever changes.
const CODE_FS_ID = "bos-src";

// Push `branch` to `remote`, recovering from a non-fast-forward rejection
// caused by BrowserOS's own checkout being shallow — Dokploy re-clones
// `code/` with `--depth 1` on every redeploy (docs/dev/deployment.md), which
// leaves git unable to prove the local branch descends from the remote's
// even when nothing really conflicts. Mirrors the recovery the per-remote
// "Push" button performs (src/app/api/git-remotes/route.ts): unshallow,
// fetch, then retry once a genuine (non-diverged) fast-forward is confirmed
// possible. Deliberately does NOT rebase or force-push on a real divergence
// — this path also runs unattended (auto-push-on-promote), so it throws a
// clear, actionable error instead of guessing; the per-remote "Push" button
// is where a human resolves that (rebase-then-retry, or an explicit
// force-push).
export async function pushWithRecovery(repoPath, remote, branch, { extraArgs = [], credArgs = [], env } = {}) {
  const attemptPush = () => git([...credArgs, "push", remote, branch, ...extraArgs], repoPath, env);
  try {
    await attemptPush();
    return;
  } catch (e) {
    const msg = e?.message || String(e);
    if (isGitAuthFailure(msg)) throw e;

    let shallow = false;
    try {
      shallow = (await git(["rev-parse", "--is-shallow-repository"], repoPath)) === "true";
    } catch (e) {
      // Can't determine shallow-ness — proceed as if not shallow; the
      // fetch below still runs and the merge-base checks after it are what
      // actually decide whether recovery is possible.
      slog("warn", "push", `could not determine shallow-ness of ${repoPath}, assuming not shallow: ${e?.message || e}`);
    }
    if (shallow) await git([...credArgs, "fetch", "--unshallow", remote], repoPath, env).catch((e2) => slog("warn", "push", `unshallow fetch failed: ${e2?.message || e2}`));
    await git([...credArgs, "fetch", remote, branch], repoPath, env).catch((e2) => slog("warn", "push", `fetch ${remote}/${branch} failed: ${e2?.message || e2}`));

    let mergeBase;
    try {
      mergeBase = await git(["merge-base", "HEAD", `${remote}/${branch}`], repoPath);
    } catch {
      throw new Error(`push to ${remote}/${branch} rejected and no shared history was found even after unshallowing — refusing to guess; resolve manually via Settings → Versions → Git Remotes. Original error: ${msg}`);
    }
    if (!mergeBase) {
      throw new Error(`push to ${remote}/${branch} rejected and no shared history was found even after unshallowing — refusing to guess; resolve manually via Settings → Versions → Git Remotes. Original error: ${msg}`);
    }
    let canFastForward = false;
    try {
      await git(["merge-base", "--is-ancestor", `${remote}/${branch}`, "HEAD"], repoPath);
      canFastForward = true;
    } catch (e) {
      // "not an ancestor" (genuine divergence) is the expected shape of this
      // failure and is handled below (throws a clear divergence error) — but
      // log it too, since an unrelated failure (git itself erroring) would
      // otherwise be indistinguishable from a real divergence in the logs.
      slog("warn", "push", `is-ancestor check for ${remote}/${branch} failed: ${e?.message || e}`);
      canFastForward = false;
    }
    if (!canFastForward) {
      throw new Error(`push to ${remote}/${branch} rejected: local and the remote have genuinely diverged (not just a shallow-history artifact) — resolve via Settings → Versions → Git Remotes, which can rebase or force-push. Original error: ${msg}`);
    }
    await attemptPush();
  }
}

// Push base's `branch` to `origin` via base's own /api/git-remotes push
// action, rather than a bare `git push` here. That route resolves
// OAuth/token credentials through BOS's git-credential-helper — credentials
// the Supervisor (a separate, unbundled Node process with no access to
// src/lib/... or the SecretsStore) has no way to supply itself. A bare `git
// push origin ...` run from here carries no credentials at all and fails
// immediately with "could not read Username for '<host>'" the moment origin
// needs auth — i.e. always, for any HTTPS remote without a cached
// system-level credential.
async function pushOriginViaBaseApi(branch) {
  if (!state.base || state.base.state !== "ready") throw new Error("Base is not ready — cannot push to origin yet");
  const res = await fetch(`http://127.0.0.1:${state.base.port}/api/git-remotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "push", name: "origin", branch }),
  });
  const respBody = await res.json().catch(() => ({}));
  const errMsg = typeof respBody?.error === "string" ? respBody.error : respBody?.error?.message;
  if (!res.ok || errMsg) throw new Error(errMsg || `push to origin/${branch} failed with HTTP ${res.status}`);
  if (respBody.rebaseConflict) {
    throw new Error(respBody.message || `push to origin/${branch}: local and remote have diverged and automatic rebase conflicted — resolve via Settings → Versions → Git Remotes`);
  }
  if (respBody.unrelatedHistory) {
    throw new Error(respBody.message || `push to origin/${branch}: no shared history with the remote`);
  }
}

export async function pushNow() {
  await pushOriginViaBaseApi(state.baseBranch);
  return { pushed: state.baseBranch };
}

// Auto-push: for each remote belonging to `filesystemId` with autoPush
// enabled in the git-remotes config, push `branch`. Remote NAMES are not
// scoping — every filesystem's remote is conventionally named "origin" (each
// repo has exactly one push target), so filtering by name would (and
// previously did) exclude every real remote in a typical deployment. A
// config with no `filesystem` tag at all is a legacy entry that belongs to
// the BOS source checkout (mirrors belongsToFilesystem in
// src/app/api/git-remotes/route.ts). Resolves each remote's stored
// credential itself — the Supervisor decrypts secrets.json directly (see
// secrets.mjs's own doc comment) rather than delegating through base's API,
// so this still works even when base isn't running. Errors are recorded
// (never just logged) but do not stop other pushes.
export async function runAutoPush(repoPath, branch, filesystemId) {
  const configPath = path.join(CANONICAL_DATA, "config", "git-remotes.json");
  let configs;
  try {
    configs = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") slog("warn", "push", `reading git-remotes.json (${configPath}) failed — auto-push skipped: ${e?.message || e}`);
    return [];
  }
  const remotes = (Array.isArray(configs) ? configs : []).filter(
    (r) => r.autoPush && (r.filesystem ?? CODE_FS_ID) === filesystemId,
  );
  if (!remotes.length) return [];
  const results = [];
  for (const remote of remotes) {
    try {
      let credArgs = [];
      let env;
      const resolved = resolveRemoteToken(CANONICAL_DATA, remote.name, remote.authType, remote.provider);
      if (resolved?.token) {
        const cred = buildGitCredential(CANONICAL_DATA, resolved.token);
        credArgs = cred.args;
        env = cred.env;
      }
      await pushWithRecovery(repoPath, remote.name, branch, { extraArgs: ["--follow-tags"], credArgs, env });
      results.push({ remoteName: remote.name, status: "success" });
      log(`auto-push to ${remote.name}: success`);
    } catch (e) {
      const msg = e.message || String(e);
      results.push({ remoteName: remote.name, status: "failed", error: msg });
      slog("warn", "promote", `auto-push to ${remote.name} failed: ${msg}`);
    }
  }
  return results;
}

// Push the just-promoted base branch to every autoPush-enabled remote
// configured for the code repo (CODE_FS_ID). Never throws — a push failure
// must not undo an already-successful promote — but every outcome is both
// logged and returned (via runAutoPush) so the caller (and ultimately the
// UI) can report "promoted, but push to X failed: <reason>" instead of a
// false all-clear.
export async function pushPromotedBase(repoPath, branch) {
  return runAutoPush(repoPath, branch, CODE_FS_ID);
}
