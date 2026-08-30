import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BASE_PORT, PUBLIC_PORT, CANONICAL_DATA, SPECS_ROOT, DEV_MAX_OLD_SPACE_MB, BASE_RESTART_BACKOFF_MS, BASE_RESTART_MAX, REPO } from "./config.mjs";
import { git } from "./gitutil.mjs";
import { addBaseWorktree } from "./worktree.mjs";
import { runBuild } from "./build.mjs";
import { startProc, stopProc, waitHealthy, wireExitHandler, setBaseExitHandler } from "./proc.mjs";
import { state, baseSupervision } from "./state.mjs";
import { log, slog } from "./log.mjs";

const napMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Regenerate the built-in app registry (src/apps/_*.generated.ts) in REPO.
// These files are gitignored, so a promote's merge never carries them —
// after merging a feature that adds/removes a BUILT-IN app we must
// regenerate, or the app's source lands on base but stays unregistered
// (invisible). `next dev` then hot-reloads the regenerated .ts. Idempotent +
// cheap. Allowed to fail without aborting a promote — but that failure must
// be visible to the caller, not just a log line (a merged built-in app
// silently staying unregistered is the exact bug this function exists to
// fix in the first place).
export async function regenApps(warnings) {
  const exec = promisify(execFile);
  try {
    await exec("node", ["tools/gen-apps.mjs"], { cwd: REPO, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    const msg = `gen-apps failed: ${e?.message || e}`;
    slog("warn", "promote", msg, {});
    if (Array.isArray(warnings)) warnings.push(msg);
  }
}

// Build + start BASE from a detached worktree at `commit` (no commit step —
// base is not a candidate branch). Runs against canonical data. A base build
// failure is fatal at boot, so this still throws after logging the captured
// reason.
export async function buildAndStartBase(commit) {
  const wt = await addBaseWorktree(commit);
  state.base = { role: "base", branch: state.baseBranch, worktree: wt, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit };
  const lctx = { branch: state.baseBranch, versionLabel: "base" };
  slog("info", "build", `building base (${state.baseBranch} @ ${commit.slice(0, 8)})`, lctx);
  const build = await runBuild(wt, state.baseBranch, lctx);
  state.base.buildLog = build.relPath;
  if (!build.ok) {
    state.base.state = "failed";
    state.base.buildError = build.reason;
    slog("error", "build", `base build FAILED (exit ${build.code})`, { ...lctx, buildLog: build.relPath, err: { message: build.reason } });
    throw new Error(`base build failed:\n${build.reason}`);
  }
  startProc(state.base);
  state.base.state = (await waitHealthy(BASE_PORT, state.base)) ? "ready" : "failed";
  slog(state.base.state === "ready" ? "info" : "error", "build", `base -> ${state.base.state}`, { ...lctx, buildLog: build.relPath });
  return state.base.state;
}

export function startBaseDevProc(v) {
  // Append rather than replace, so an operator-supplied NODE_OPTIONS survives.
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    DEV_MAX_OLD_SPACE_MB > 0 ? `--max-old-space-size=${DEV_MAX_OLD_SPACE_MB}` : "",
  ].filter(Boolean).join(" ");
  if (DEV_MAX_OLD_SPACE_MB > 0) {
    log(`base dev server memory ceiling: --max-old-space-size=${DEV_MAX_OLD_SPACE_MB} (expect RSS ~${DEV_MAX_OLD_SPACE_MB * 2} MB; Next recycles the server at the threshold)`);
  }
  // Run via `npm run dev` (not `npx next dev`) so the `predev` hook
  // regenerates the built-in app registry on every start/restart. Pass the
  // port after `--`.
  v.proc = spawn("npm", ["run", "dev", "--", "-p", String(v.port)], {
    cwd: REPO,
    env: {
      ...process.env,
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      PORT: String(v.port),
      BOS_DATA_DIR: CANONICAL_DATA,
      BOS_CANONICAL_DATA: CANONICAL_DATA,
      BOS_VERSION_LABEL: "base",
      BOS_BASE_BRANCH: state.baseBranch,
      BOS_SPECS_ROOT: SPECS_ROOT,
      BOS_SUPERVISOR_URL: `http://127.0.0.1:${PUBLIC_PORT}`,
    },
    // Redirect Next.js stderr → supervisor stdout so Docker/Dokploy doesn't
    // classify normal request logs (which Next.js writes to stderr) as errors.
    stdio: ["inherit", "inherit", process.stdout],
    detached: true,
  });
  wireExitHandler(v);
}

// Start base as a Supervisor-owned `next dev` process (single-process model).
export async function buildAndStartBaseDev() {
  let commit;
  try {
    commit = await git(["rev-parse", "HEAD"]);
  } catch (e) {
    throw new Error(`cannot resolve base commit for owned dev mode: ${e?.message || e}`);
  }
  state.base = { role: "base", branch: state.baseBranch, worktree: REPO, dataDir: CANONICAL_DATA, port: BASE_PORT, state: "building", proc: null, commit, dev: true };
  slog("info", "build", `starting owned base dev server (${state.baseBranch}) on :${BASE_PORT}`, { branch: state.baseBranch, versionLabel: "base" });
  startBaseDevProc(state.base);
  state.base.state = (await waitHealthy(BASE_PORT, state.base)) ? "ready" : "failed";
  if (state.base.state !== "ready") throw new Error(`base dev server failed to become healthy on :${BASE_PORT}`);
  log(`owned base dev server ready on :${BASE_PORT} (branch ${state.baseBranch})`);
  return state.base.state;
}

/**
 * Bring base back after it died on its own.
 *
 * The Supervisor is PID 1 in the container, so when the base server dies
 * the container stays "up" while BOS is unreachable — nothing outside
 * notices. This closes that gap. It is NOT a substitute for fixing why base
 * died: every restart is logged at error level and counted in
 * baseSupervision, which the bastion's System Monitor surfaces.
 *
 * A reused external base (BOS_ACTIVE_REUSE_PORT) is the user's own process
 * and is left alone.
 */
export async function restartBase(reason) {
  if (state.shuttingDown || state.baseRestarting || baseSupervision.givenUp) return;
  if (!state.base) return;
  if (state.base.reused) {
    slog("error", "process", `base (reused, external) stopped responding: ${reason} — the Supervisor cannot restart a server it does not own`, { versionLabel: "base" });
    return;
  }

  state.baseRestarting = true;
  try {
    while (!state.shuttingDown) {
      if (baseSupervision.consecutiveFailures >= BASE_RESTART_MAX) {
        baseSupervision.givenUp = true;
        state.base.state = "failed";
        state.base.buildError = `base server keeps dying (${reason}); gave up after ${baseSupervision.consecutiveFailures} restart attempts`;
        slog("error", "process", state.base.buildError, { versionLabel: "base", data: { restarts: baseSupervision.restarts } });
        return;
      }

      const attempt = baseSupervision.consecutiveFailures;
      await napMs(BASE_RESTART_BACKOFF_MS[attempt]);
      if (state.shuttingDown) return;

      baseSupervision.restarts += 1;
      baseSupervision.consecutiveFailures += 1;
      baseSupervision.lastRestartAt = Date.now();
      slog("error", "process", `base server died (${reason}) — restarting (attempt ${attempt + 1}/${BASE_RESTART_MAX})`, {
        versionLabel: "base",
        data: { attempt: attempt + 1, totalRestarts: baseSupervision.restarts },
      });

      state.base.state = "building";
      if (state.base.dev) startBaseDevProc(state.base);
      else startProc(state.base);

      if (await waitHealthy(state.base.port, state.base)) {
        state.base.state = "ready";
        baseSupervision.consecutiveFailures = 0;
        log(`base server restarted and healthy on :${state.base.port} (${baseSupervision.restarts} restart(s) total)`);
        return;
      }
      // Didn't come up — reap whatever is left and fall through to the next backoff step.
      await stopProc(state.base);
    }
  } finally {
    state.baseRestarting = false;
  }
}

// Wire proc.mjs's generic exit handler back to this module's restart policy
// — must run once at boot, before any base process is started (proc.mjs
// cannot import base.mjs directly without creating a cycle: base.mjs already
// imports proc.mjs for startProc/stopProc/waitHealthy).
setBaseExitHandler((reason) => void restartBase(reason));
