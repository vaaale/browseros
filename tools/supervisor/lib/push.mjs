import { promises as fs } from "node:fs";
import path from "node:path";
import { CANONICAL_DATA, REMOTE, PUSH_MODE } from "./config.mjs";
import { git } from "./gitutil.mjs";
import { state } from "./state.mjs";
import { log, slog } from "./log.mjs";
import { isGitAuthFailure } from "./git-auth.mjs";

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
export async function pushWithRecovery(repoPath, remote, branch, extraArgs = []) {
  try {
    await git(["push", remote, branch, ...extraArgs], repoPath);
    return;
  } catch (e) {
    const msg = e?.message || String(e);
    if (isGitAuthFailure(msg)) throw e;

    let shallow = false;
    try {
      shallow = (await git(["rev-parse", "--is-shallow-repository"], repoPath)) === "true";
    } catch {
      // Can't determine shallow-ness — proceed as if not shallow; the
      // fetch below still runs and the merge-base checks after it are what
      // actually decide whether recovery is possible.
    }
    if (shallow) await git(["fetch", "--unshallow", remote], repoPath).catch((e2) => slog("warn", "push", `unshallow fetch failed: ${e2?.message || e2}`));
    await git(["fetch", remote, branch], repoPath).catch((e2) => slog("warn", "push", `fetch ${remote}/${branch} failed: ${e2?.message || e2}`));

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
    } catch {
      canFastForward = false;
    }
    if (!canFastForward) {
      throw new Error(`push to ${remote}/${branch} rejected: local and the remote have genuinely diverged (not just a shallow-history artifact) — resolve via Settings → Versions → Git Remotes, which can rebase or force-push. Original error: ${msg}`);
    }
    await git(["push", remote, branch, ...extraArgs], repoPath);
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

// Auto-push: for each non-origin remote with autoPush enabled in the
// git-remotes config, push the base branch. Errors are recorded (never just
// logged) but do not stop other pushes.
export async function runAutoPush(repoPath, branch) {
  const configPath = path.join(CANONICAL_DATA, "config", "git-remotes.json");
  let configs;
  try {
    configs = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return [];
  }
  const remotes = (Array.isArray(configs) ? configs : []).filter((r) => r.autoPush && r.name !== "origin");
  if (!remotes.length) return [];
  const results = [];
  for (const remote of remotes) {
    try {
      await pushWithRecovery(repoPath, remote.name, branch, ["--follow-tags"]);
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

// Push the just-promoted base branch to origin (gated by PUSH_MODE) and to
// every autoPush-enabled remote. Never throws — a push failure must not
// undo an already-successful promote — but every outcome is both logged and
// returned so the caller (and ultimately the UI) can report "promoted, but
// push to X failed: <reason>" instead of a false all-clear.
export async function pushPromotedBase(repoPath, branch) {
  const results = [];
  if (PUSH_MODE === "auto-on-promote") {
    try {
      await pushOriginViaBaseApi(branch);
      results.push({ remoteName: REMOTE, status: "success" });
      log(`auto-push to ${REMOTE}: success`);
    } catch (e) {
      const msg = e.message || String(e);
      results.push({ remoteName: REMOTE, status: "failed", error: msg });
      slog("error", "promote", `auto-push to ${REMOTE} failed: ${msg}`, { branch, versionLabel: "base" });
    }
  }
  results.push(...(await runAutoPush(repoPath, branch)));
  return results;
}
