import http from "node:http";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { BASE_PORT, POOL_SIZE, HEALTH_TIMEOUT_MS, CANONICAL_DATA, PUBLIC_PORT, SPECS_ROOT } from "./config.mjs";
import { state, previews, baseSupervision } from "./state.mjs";
import { log, slog } from "./log.mjs";

const exec = promisify(execFile);

// Injected by base.mjs at boot (setBaseExitHandler(restartBase)) — breaks the
// circular import that would otherwise exist between proc.mjs (spawns/kills
// processes) and base.mjs (owns the restart-on-crash policy for the base
// process specifically).
let onBaseUnexpectedExit = null;
export function setBaseExitHandler(fn) {
  onBaseUnexpectedExit = fn;
}

// "Occupied" means SOMETHING is listening on this port — not "something
// answered our HTTP GET." A raw TCP/WebSocket-only listener (e.g. a service's
// own daemon that never speaks plain HTTP, like Terminal's WebSocketServer)
// accepts the TCP connection but never sends a valid HTTP response, so the
// GET request just times out — which used to be misread as "nothing here,
// free" and let allocPreviewPort() hand that same port to a new preview
// build, which then failed with a real EADDRINUSE. Track the TCP-level
// connect event separately from the HTTP-level response: a successful TCP
// connect, even with no/garbled HTTP reply afterward, is occupied; only an
// outright connection refusal (nothing listening at all) is free.
export function probeOnce(port) {
  return new Promise((resolve) => {
    let connected = false;
    const r = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => { res.resume(); resolve(true); });
    r.on("socket", (socket) => { socket.once("connect", () => { connected = true; }); });
    r.on("error", () => resolve(connected));
    r.on("timeout", () => { r.destroy(); resolve(connected); });
  });
}

// Lowest free preview port in (BASE_PORT, BASE_PORT+POOL_SIZE]. Skips ports
// held by a tracked version or anything foreign already listening
// (probe-before-bind).
export async function allocPreviewPort() {
  const used = new Set();
  if (state.base?.port) used.add(state.base.port);
  for (const p of previews.values()) if (p.port) used.add(p.port);
  for (let p = BASE_PORT + 1; p <= BASE_PORT + POOL_SIZE; p++) {
    if (used.has(p)) continue;
    if (await probeOnce(p)) continue;
    return p;
  }
  throw new Error(`no free preview port in pool ${BASE_PORT + 1}-${BASE_PORT + POOL_SIZE}`);
}

/** True when this exit was caused by us (Stop / promote swap / shutdown). Single-shot. */
export function consumeExpectedExit(v) {
  const expected = v.expectingExit === true;
  v.expectingExit = false;
  return expected;
}

export function describeExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `code ${code ?? "null"}`;
}

/**
 * Log a child server's exit with the SIGNAL included, not just the code.
 *
 * Why the signal matters: when the kernel OOM-kills `next dev`'s next-server
 * child, the parent `next dev` process exits with code 0 — so logging only
 * the code reports a clean shutdown for what was actually an out-of-memory
 * kill. That masked a real production OOM for 10 hours. A SIGKILL, or a
 * code-0 exit from a server that was healthy and serving, both get flagged
 * here.
 */
function recordExit(v, code, signal, expected) {
  const oomSuspected = signal === "SIGKILL" || (!expected && code === 0 && v.state === "ready");
  const isBase = v === state.base;
  const label = isBase ? "base" : `version "${v.role}"`;
  const detail = describeExit(code, signal);
  const suffix = oomSuspected
    ? " — SIGKILL or a clean exit from a serving process usually means the kernel OOM killer; check `dmesg` and the cgroup's memory.events oom_kill counter"
    : "";
  if (isBase) {
    baseSupervision.lastExit = { code: code ?? null, signal: signal ?? null, at: Date.now(), expected, oomSuspected };
  }
  slog(expected ? "info" : "error", "process", `${label} server exited (${detail})${expected ? ", as requested" : suffix}`, {
    branch: v.branch,
    versionLabel: isBase ? "base" : v.role,
    data: { code: code ?? null, signal: signal ?? null, expected, oomSuspected },
  });
}

// Shared exit-handling contract for any spawned Version process — reused by
// base.mjs's startBaseDevProc (a different spawn command, `npm run dev`
// instead of `npx next start`) so both paths react to crashes identically.
export function wireExitHandler(v) {
  v.proc.on("exit", (code, signal) => {
    const expected = consumeExpectedExit(v);
    recordExit(v, code, signal, expected);
    // An unexpected death of a running version must not keep routing traffic
    // to a dead port — mark it so pinnedVersion falls back to base.
    if (v.state === "ready") v.state = "stopped";
    else if (v.state === "building") {
      v.state = "failed";
      v.buildError = `preview process exited before becoming healthy (${describeExit(code, signal)})`;
    }
    if (!expected && v === state.base) onBaseUnexpectedExit?.(describeExit(code, signal));
  });
}

export function startProc(v) {
  v.proc = spawn("npx", ["next", "start", "-p", String(v.port)], {
    cwd: v.worktree,
    // BOS_CANONICAL_DATA lets a version persist cross-version state (e.g.
    // chat conversation metadata) to canonical data even when it runs on a
    // throwaway preview clone, so it survives Stop/promote. Explicit spec
    // root per role (020): previews read/write their own mounted store
    // worktrees (feature branch); base reads the canonical stores. Previews
    // must not seed stores — a seed commit would land on the feature branch.
    env: {
      ...process.env,
      PORT: String(v.port),
      BOS_DATA_DIR: v.dataDir,
      BOS_CANONICAL_DATA: CANONICAL_DATA,
      BOS_VERSION_LABEL: v.role,
      BOS_BASE_BRANCH: state.baseBranch,
      // EVERY server the Supervisor spawns must be supervisor-aware. This
      // keys off BOS_SUPERVISOR_URL: the service-WebSocket proxy path,
      // supervisor-backed git, and log shipping to the central store.
      BOS_SUPERVISOR_URL: `http://127.0.0.1:${PUBLIC_PORT}`,
      BOS_SPECS_ROOT: v.role === "preview" ? path.join(v.worktree, "specs") : SPECS_ROOT,
      ...(v.role === "preview" ? { BOS_SPECS_SEED: "0" } : {}),
      // A service entrypoint lives under dataDir()/user-apps/items/<id>/services/,
      // not this checkout (v.worktree) — so a bare import like require("ws")
      // only resolves by directory-walk accident when dataDir() happens to be
      // nested under the checkout (true for base, false for every preview,
      // whose data clone is a sibling directory tree). NODE_PATH must be part
      // of THIS process's own initial env for Node to honor it at all — it is
      // read once at bootstrap (Module._initPaths()), so mutating
      // process.env.NODE_PATH later, or a worker_threads Worker's own per-
      // instance env, are both too late/too narrow; setting it here fixes
      // every require()/import() in this process AND every Worker it spawns
      // (which inherit process.env by default) in one place.
      NODE_PATH: process.env.NODE_PATH
        ? `${process.env.NODE_PATH}${path.delimiter}${path.join(v.worktree, "node_modules")}`
        : path.join(v.worktree, "node_modules"),
    },
    // Redirect Next.js stderr → supervisor stdout so Docker/Dokploy doesn't
    // classify normal request logs (which Next.js writes to stderr) as errors.
    stdio: ["inherit", "inherit", process.stdout],
    // detached: true puts the child in its own process group so stopProc can
    // kill the ENTIRE group (npx + its next-server child) via negative PID.
    // Without this, killing npx orphans the next process which keeps the port.
    detached: true,
  });
  wireExitHandler(v);
}

// Stop a version's server and RESOLVE ONLY AFTER it has actually exited, so
// the port is free to rebind (critical when reusing the base port on
// promote). SIGKILL escalation guards against a process that ignores
// SIGTERM.
export function stopProc(v) {
  return new Promise((resolve) => {
    const p = v?.proc;
    if (!p || p.killed || p.exitCode !== null || p.signalCode) { if (v) v.proc = null; return resolve(); }
    // Tell the exit handler this death is deliberate, so base supervision
    // does not treat a Stop / promote swap / shutdown as a crash and
    // respawn it.
    v.expectingExit = true;
    const pid = p.pid;
    p.once("exit", () => { v.proc = null; resolve(); });
    // Kill the entire process group (negative PID) so child processes
    // spawned by npx (i.e. next-server) are also terminated. Without this,
    // npx exits but next-server is orphaned and keeps holding the port →
    // EADDRINUSE on rebuild.
    const killGroup = (sig) => {
      try { process.kill(-pid, sig); }
      catch { try { p.kill(sig); } catch { /* already gone — nothing left to signal */ } }
    };
    killGroup("SIGTERM");
    setTimeout(() => {
      if (p.exitCode === null && !p.signalCode) killGroup("SIGKILL");
    }, 5000);
  });
}

export async function waitHealthy(port, v) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (v?.proc && (v.proc.exitCode !== null || v.proc.signalCode)) return false;
    if (v?.state === "failed" && v.buildError) return false;
    const ok = await new Promise((resolve) => {
      const r = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 4000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => { try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); } });
      });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// On supervisor restart any previously-spawned preview servers may still be
// listening on their pool ports (e.g. when the supervisor was SIGKILL'd). We
// probe each preview port and, for any that responds, find the owning PID
// via `ss -tlnp` (Linux) and send it SIGTERM (escalating to SIGKILL after
// 5s). Ports that don't respond are already free — nothing to do. BASE_PORT
// itself is NOT touched here; buildAndStartBase will start fresh there.
export async function reapOrphanedPreviewServers() {
  const reaped = [];
  for (let p = BASE_PORT + 1; p <= BASE_PORT + POOL_SIZE; p++) {
    if (!(await probeOnce(p))) continue; // nothing listening — free
    // Find PID(s) via `ss`. Output lines look like:
    //   LISTEN 0 511 *:<port> *:* users:(("next-server",pid=12345,fd=6))
    let pid = null;
    try {
      const { stdout } = await exec("ss", ["-tlnp", `sport = :${p}`], { maxBuffer: 256 * 1024 });
      const m = stdout.match(/pid=(\d+)/);
      if (m) pid = Number(m[1]);
    } catch {
      // ss not available or failed — fall back to fuser.
      try {
        const { stdout } = await exec("fuser", [`${p}/tcp`], { maxBuffer: 64 * 1024 });
        const m = stdout.trim().match(/\d+/);
        if (m) pid = Number(m[0]);
      } catch {
        // Neither tool found a PID for an occupied port — nothing more we
        // can determine; fall through and skip it (logged below).
      }
    }
    if (!pid) {
      log(`reap: port ${p} occupied but could not determine PID — skipping`);
      continue;
    }
    slog("warn", "reap", `reaping orphaned preview server on port ${p} (pid ${pid})`, { data: { port: p, pid } });
    try {
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    } catch {
      // pid already gone by the time we got here — nothing to reap.
    }
    reaped.push({ port: p, pid });
  }
  if (reaped.length) log(`reaped ${reaped.length} orphaned preview server(s): ${reaped.map((r) => `port ${r.port} pid ${r.pid}`).join(", ")}`);
}
