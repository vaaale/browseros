#!/usr/bin/env node
// BrowserOS Supervisor — the stable control plane for live version control
// (specs/005-self-modification/spec.md, run-model A).
//
// It owns the PUBLIC port and reverse-proxies to internal `next start` instances:
//  - BASE: the current promoted code, ALWAYS running on BASE_PORT.
//  - PREVIEW: at most one feature branch being viewed, on a port drawn from a pool
//    above BASE_PORT. Previews live in branch-named worktrees so the bookkeeping
//    survives restarts and a branch can be resumed after a Stop.
// It serves the version-independent /__supervisor control surface so the running
// OS can be swapped safely.
//
// Standalone & dependency-light (Node built-ins only): the Supervisor is the
// trusted kernel and is NOT itself self-modified. Run: `npm run supervisor`.
//
// This file is intentionally thin — it only boots the process and wires the
// HTTP server. Everything else lives under lib/, organized by dependency
// layer (see each file's own header comment):
//   state.mjs, config.mjs, gitutil.mjs, log.mjs   — leaves, no internal deps
//   proc.mjs, worktree.mjs, coupled-repos.mjs      — process/git/repo primitives
//   base.mjs, preview.mjs, build.mjs               — version lifecycles
//   reconcile-client.mjs, push.mjs, promote.mjs    — orchestration
//   control.mjs                                    — the HTTP control surface

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PUBLIC_PORT, BASE_PORT, POOL_SIZE, CANONICAL_DATA, BASE_DEV, REUSE_BASE_PORT } from "./lib/config.mjs";
import { git } from "./lib/gitutil.mjs";
import { initLogStore, getLogStore, startPruneInterval, log, slog } from "./lib/log.mjs";
import { probeOnce, reapOrphanedPreviewServers, stopProc } from "./lib/proc.mjs";
import { reconcileWorktrees, reconcileWorktreeDirs, reconcileFeatureBranches, reconcileDataClones, assertRepoIntegrity } from "./lib/worktree.mjs";
import { pruneAllCoupledWorktrees } from "./lib/coupled-repos.mjs";
import { buildAndStartBase, buildAndStartBaseDev } from "./lib/base.mjs";
import { restorePreviews } from "./lib/preview.mjs";
import { state, previews } from "./lib/state.mjs";
import { handleControl, pinnedVersion, proxyTo, forwardUpgrade, proxyServiceHttp, proxyServiceUpgrade } from "./lib/control.mjs";

initLogStore(CANONICAL_DATA);

async function main() {
  if (!state.baseBranch) state.baseBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  // Order matters, and each step depends on the one before it.
  //
  //   worktrees      registration-driven; safety-COMMITS a dirty worktree
  //                  before removing it, so work in flight becomes a commit
  //   branches       merged-only, so the commit just made protects its branch
  //   worktree dirs  what git has disowned; a branch reclaimed above makes its
  //                  leftover directory reclaimable in this same boot
  //   clones         same, for the data clone
  //
  // Running the two directory-driven sweeps AFTER the branch pass is what lets
  // one boot finish the job instead of leaving debris for the next one.
  await reconcileWorktrees();
  await reconcileFeatureBranches();
  await reconcileWorktreeDirs();
  await reconcileDataClones();
  await pruneAllCoupledWorktrees();
  await reapOrphanedPreviewServers();
  // Post-start safety gate: assert (and restore) the live checkout before accepting traffic.
  await assertRepoIntegrity("startup");

  // Logging retention (best-effort from the `logging` config namespace) + periodic prune.
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(CANONICAL_DATA, "config", "logging.json"), "utf8"));
    const logStore = getLogStore();
    if (Number(cfg.retentionDays) > 0) logStore.retentionDays = Number(cfg.retentionDays);
    if (Number(cfg.maxSizeMb) > 0) logStore.maxBytes = Number(cfg.maxSizeMb) * 1024 * 1024;
  } catch (e) {
    // ENOENT (no logging.json written yet) is expected — LogStore's own
    // defaults apply silently. Malformed JSON doing the same is a real
    // misconfiguration worth surfacing.
    if (e?.code !== "ENOENT") slog("warn", "boot", `reading logging.json failed, using LogStore defaults: ${e?.message || e}`);
  }
  startPruneInterval();

  if (BASE_DEV) {
    await buildAndStartBaseDev();
  } else if (REUSE_BASE_PORT) {
    let commit;
    try { commit = await git(["rev-parse", "HEAD"]); } catch (e) {
      slog("warn", "boot", `reading current commit failed: ${e?.message || e}`);
      commit = undefined;
    }
    state.base = { role: "base", port: REUSE_BASE_PORT, state: "ready", reused: true, branch: state.baseBranch, commit };
    log(`reusing existing server on :${REUSE_BASE_PORT} as base (dev mode)`);
    if (!(await probeOnce(REUSE_BASE_PORT))) {
      log(`WARNING: nothing is responding on :${REUSE_BASE_PORT}. Reuse mode proxies base there — start \`npm run dev\` on :${REUSE_BASE_PORT} first, or set BOS_BASE_DEV=1 so the Supervisor owns + serves base itself.`);
    }
  } else {
    await buildAndStartBase(await git(["rev-parse", "HEAD"]));
  }

  // Restore previews from git branches. Runtime state is reconstructed, not persisted.
  await restorePreviews();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    // A service's own plain-HTTP traffic, at /__supervisor/services/<id>(/...)
    // — checked before the generic /__supervisor/* control-route branch
    // below, since this shares the same prefix.
    const svcMatch = url.pathname.match(/^\/__supervisor\/services\/([a-zA-Z0-9._-]+)(\/.*)?$/);
    if (svcMatch) {
      const subPath = (svcMatch[2] || "/") + url.search;
      void proxyServiceHttp(svcMatch[1], subPath, req, res);
      return;
    }
    if (url.pathname === "/__supervisor" || url.pathname.startsWith("/__supervisor/")) {
      const sub = url.pathname === "/__supervisor" ? "" : url.pathname.slice("/__supervisor/".length);
      void handleControl(req, res, sub);
      return;
    }
    const port = pinnedVersion(req)?.port;
    if (!port) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("No base version"); return; }
    proxyTo(port, req, res);
  });

  // Proxy WebSocket upgrades: a service's own socket (e.g. Terminal's shell
  // socket, at /__supervisor/services/<id>/ws) takes priority; everything
  // else (e.g. next dev's HMR socket) forwards to the pinned version as before.
  server.on("upgrade", (req, clientSocket, head) => {
    const url = new URL(req.url, "http://localhost");
    const svcMatch = url.pathname.match(/^\/__supervisor\/services\/([a-zA-Z0-9._-]+)\/ws$/);
    if (svcMatch) {
      void proxyServiceUpgrade(svcMatch[1], req, clientSocket, head);
      return;
    }
    const port = pinnedVersion(req)?.port;
    if (!port) return clientSocket.destroy();
    forwardUpgrade(port, req, clientSocket, head);
  });

  server.listen(PUBLIC_PORT, () => log(`listening on :${PUBLIC_PORT} (base branch: ${state.baseBranch}, base port: ${BASE_PORT}, preview pool: ${BASE_PORT + 1}-${BASE_PORT + POOL_SIZE}); control at /__supervisor`));
}

// Kill the Supervisor's OWNED servers (base + all previews) when it exits.
// Those children are spawned `detached` (own process group) so stopProc can
// kill the whole group — but detached also means they would OUTLIVE the
// Supervisor on Ctrl+C. Reap them here. A reused (external) base has no
// owned proc and is left alone (it's the user's own process).
async function shutdown(signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log(`received ${signal} — stopping owned servers (base + previews)`);
  try {
    await Promise.all([stopProc(state.base), ...[...previews.values()].map((p) => stopProc(p))]);
  } catch (e) {
    log(`shutdown: best-effort stop of owned servers hit an error (exiting anyway): ${e?.message || e}`);
  }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => void shutdown(sig));

main().catch((e) => { console.error("[supervisor] fatal:", e); process.exit(1); });
