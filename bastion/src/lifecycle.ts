import fs from "fs";
import path from "path";
import type { Config } from "./config";
import {
  containerName,
  createBosContainer,
  startContainer,
  stopContainer,
  inspectContainer,
  listBosContainers,
  reconcileNetworkAttachment,
  waitForHealthy,
  fetchSupervisorHealth,
} from "./docker";
import type { SupervisorHealth } from "./docker";
import { provisionUser } from "./provision";
import * as logStore from "./log-store";

/**
 * "unhealthy" is distinct from "stopped" on purpose: the container is running but
 * BOS inside it is not serving. That combination is invisible to Docker (the
 * Supervisor is PID 1 and stays alive when the base server dies) and it kept a
 * production instance dead for 10 hours on 2026-07-29 while `docker ps` reported
 * "Up". The health monitor below exists to surface it.
 */
export type InstanceStatus = "running" | "unhealthy" | "stopped" | "provisioning" | "unknown";

export interface InstanceState {
  username: string;
  containerId?: string;
  status: InstanceStatus;
  lastActive: number;
  provisionLog?: string;
  provisionError?: string;
  /** Short human-readable reason for the last failure. */
  error?: string;
  /** Last real health report from the container's Supervisor (null = unreachable). */
  health?: SupervisorHealth | null;
  /** When the health monitor last checked this instance. */
  healthCheckedAt?: number;
}

const instances = new Map<string, InstanceState>();
const inFlight = new Map<string, Promise<void>>();

let _cfg: Config;
let healthTimer: ReturnType<typeof setInterval> | null = null;

/** How often the health monitor re-checks every known instance. */
const HEALTH_POLL_MS = 30_000;

/**
 * How long to wait for a container to start serving. Generous because base now
 * runs in production mode (BOS_BASE_DEV=0): a cold start runs `npm install` AND
 * a full `next build` before BOS can answer a request.
 */
const STARTUP_TIMEOUT_MS = 20 * 60_000;

export function initLifecycle(cfg: Config): void {
  _cfg = cfg;
  loadInstancesFromDisk(cfg);
  startHealthMonitor(cfg);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOrProvision(username: string, cfg: Config): Promise<void> {
  const existing = inFlight.get(username);
  if (existing) return existing;

  const work = _getOrProvision(username, cfg);
  inFlight.set(username, work);
  try {
    await work;
  } finally {
    inFlight.delete(username);
  }
}

function log(username: string, msg: string, cfg: Config): void {
  const ts = new Date().toISOString();
  console.log(`[bastion] [${username}] ${msg}`);
  logStore.append(username, msg);
  updateState(username, { provisionLog: `[${ts}] ${msg}` }, cfg);
}

/**
 * Self-heal a stale container by recreating it fresh against the CURRENT network
 * and waiting for health. The common trigger is a container bound to a network
 * ID that no longer exists after a `docker compose` rebuild/recreate of bos-net
 * ("network … not found" on start). createBosContainer ensures the network
 * exists and evicts the stale container first; src/data bind mounts are
 * preserved, so no user data is lost. Returns the new container ID.
 */
async function recreateAndHeal(username: string, cfg: Config): Promise<string> {
  const newId = await createBosContainer(username, cfg, (msg) => log(username, msg, cfg));
  await startContainer(newId);
  updateState(username, { containerId: newId, status: "provisioning", provisionError: undefined, lastActive: Date.now() }, cfg);
  await waitForHealthy(username, STARTUP_TIMEOUT_MS);
  return newId;
}

async function _getOrProvision(username: string, cfg: Config): Promise<void> {
  const state = instances.get(username);

  // Fast path: already confirmed running — skip Docker round-trip.
  if (state?.status === "running") {
    touchInstance(username);
    return;
  }

  // For every other state (stopped, unknown, absent) always re-check Docker
  // by container NAME. Stored containerId is intentionally ignored here — it
  // can be stale after a re-provision, a manual `docker rm`, or a bastion
  // restart where the instance was recreated with a new ID.
  log(username, "Checking container state…", cfg);
  const info = await inspectContainer(containerName(username));

  if (info) {
    let cid = info.Id;
    if (info.State.Running) {
      // Container is running — health-gate before declaring ready so we don't
      // mark it "running" while the supervisor / Next.js is still starting up.
      log(username, "Container is running — waiting for supervisor to become healthy…", cfg);
      updateState(username, { containerId: cid, status: "provisioning", provisionError: undefined, lastActive: Date.now() }, cfg);
      try {
        await waitForHealthy(username, STARTUP_TIMEOUT_MS);
      } catch (err) {
        // A "running" container can still be unreachable — e.g. bos-net was
        // recreated underneath it, breaking its networking. Recreate it once
        // against the current network before giving up.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bastion] [${username}] Health check failed, recreating container:`, msg);
        log(username, `Health check failed (${msg}) — recreating container against current network…`, cfg);
        try {
          cid = await recreateAndHeal(username, cfg);
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          const stack2 = err2 instanceof Error ? (err2.stack ?? msg2) : msg2;
          console.error(`[bastion] [${username}] Recreate/health failed:`, stack2);
          logStore.append(username, `ERROR (recreate): ${stack2}`);
          updateState(username, { status: "unknown", provisionError: stack2, error: msg2, lastActive: Date.now() }, cfg);
          throw err2;
        }
      }
      log(username, "Instance is ready!", cfg);
      updateState(username, { containerId: cid, status: "running", error: undefined, lastActive: Date.now() }, cfg);
      return;
    }
    // Container exists but is stopped — start it.
    log(username, "Container is stopped — starting…", cfg);
    updateState(username, { containerId: cid, status: "stopped", provisionError: undefined }, cfg);
    try {
      // Defensive re-check in case the network changed since startup
      // reconciliation ran (rare, but cheap to guard against). See FR-019.
      await reconcileNetworkAttachment(cid, cfg.bosNet).catch((err) => {
        console.error(`[bastion] [${username}] pre-start network reconcile failed (non-fatal):`, err);
      });
      await startContainer(cid);
      log(username, "Container started — waiting for supervisor and Next.js to become healthy (npm install may run)…", cfg);
      await waitForHealthy(username, STARTUP_TIMEOUT_MS);
    } catch (err) {
      // Self-heal: a stopped container often can't be started after infra
      // changes — most commonly it references a network ID that no longer exists
      // once `docker compose` rebuilt/recreated bos-net ("network … not found").
      // Recreate it fresh against the current network.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bastion] [${username}] Start failed, recreating container:`, msg);
      log(username, `Start failed (${msg}) — recreating container against current network…`, cfg);
      try {
        cid = await recreateAndHeal(username, cfg);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        const stack2 = err2 instanceof Error ? (err2.stack ?? msg2) : msg2;
        console.error(`[bastion] [${username}] Recreate/start failed:`, stack2);
        logStore.append(username, `ERROR (recreate): ${stack2}`);
        updateState(username, { status: "unknown", provisionError: stack2, error: msg2, lastActive: Date.now() }, cfg);
        throw err2;
      }
    }
    log(username, "Instance is ready!", cfg);
    updateState(username, { containerId: cid, status: "running", error: undefined, lastActive: Date.now() }, cfg);
    return;
  }

  // No container at all — full provision.
  const runningCount = [...instances.values()].filter((s) => s.status === "running").length;
  if (runningCount >= cfg.maxConcurrentInstances) {
    throw new Error(`Max concurrent instances (${cfg.maxConcurrentInstances}) reached`);
  }

  log(username, "No container found — starting full provision…", cfg);
  updateState(username, { status: "provisioning", provisionError: undefined, lastActive: Date.now() }, cfg);
  try {
    log(username, "Cloning source repository…", cfg);
    // Progress reported through log() so a first-ever login on a deployment
    // whose image hasn't been built yet shows the build happening on the
    // status page, rather than sitting on "Cloning source repository…" for
    // several minutes with no explanation.
    const containerId = await provisionUser(username, cfg, (msg) => log(username, msg, cfg));
    log(username, "Container created — waiting for supervisor and Next.js to become healthy (npm install will run on first start)…", cfg);
    await waitForHealthy(username, STARTUP_TIMEOUT_MS);
    log(username, "Instance is ready!", cfg);
    updateState(username, { containerId, status: "running", error: undefined, lastActive: Date.now() }, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? msg) : msg;
    console.error(`[bastion] [${username}] Provision failed:`, stack);
    logStore.append(username, `ERROR (provision): ${stack}`);
    updateState(username, { status: "unknown", provisionError: stack, error: msg, lastActive: Date.now() }, cfg);
    throw err;
  }
}

/** Record user activity. A container's lifetime does NOT depend on this — it
 *  runs until something explicitly stops it — but the timestamp is useful in the
 *  admin UI for spotting idle instances. */
export function touchInstance(username: string): void {
  if (!instances.has(username) || !_cfg) return;
  // Coalesced: this runs on every proxied request and the value it records is
  // decoration. See schedulePersist.
  updateState(username, { lastActive: Date.now() }, _cfg, { coalesce: true });
}

/**
 * Stop a user's container. Only ever called explicitly — by an admin action, a
 * reprovision operation, or bastion shutdown. There is deliberately NO idle or
 * session-expiry reaper: a user's container stays running until someone stops
 * it. Logged (including the caller's reason) because a silent stop previously
 * made overnight disappearances impossible to explain from the bastion log.
 */
export async function stopInstance(username: string, reason = "explicit request"): Promise<void> {
  // Re-inspect by name so we use the current container ID, not a stale one.
  const info = await inspectContainer(containerName(username)).catch(() => null);
  if (info?.State.Running) {
    log(username, `Stopping container (${reason})…`, _cfg);
    await stopContainer(info.Id).catch(console.error);
    log(username, "Container stopped.", _cfg);
  } else {
    log(username, `Stop requested (${reason}) but container is not running.`, _cfg);
  }
  updateState(username, { status: "stopped", health: null }, _cfg);
}

/** Clear a user's lifecycle state so the next getOrProvision re-checks Docker
 *  from scratch. Call this after any re-provision operation. */
export function clearInstanceState(username: string): void {
  instances.delete(username);
  if (_cfg) persistInstancesToDisk(_cfg);
}

// ── Health monitor ────────────────────────────────────────────────────────────

/**
 * Poll every known instance for its REAL state and keep InstanceState in sync.
 *
 * Without this the bastion marked an instance "running" once at login and never
 * looked again, so a container whose BOS had died still showed as healthy
 * indefinitely. Docker's own view is not enough either — it only knows the
 * container process (the Supervisor) is alive.
 */
function startHealthMonitor(cfg: Config): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => { void refreshAllHealth(cfg); }, HEALTH_POLL_MS);
  // Don't hold the event loop open just for monitoring.
  healthTimer.unref?.();
}

export function stopHealthMonitor(): void {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

export async function refreshAllHealth(cfg: Config): Promise<void> {
  await Promise.allSettled([...instances.keys()].map((username) => refreshHealth(username, cfg)));
}

/** Re-derive one instance's status from Docker + the container's Supervisor. */
export async function refreshHealth(username: string, cfg: Config): Promise<InstanceState | undefined> {
  const state = instances.get(username);
  // Never fight an in-flight provision/start for ownership of the status field.
  if (state?.status === "provisioning" || inFlight.has(username)) return state;

  const info = await inspectContainer(containerName(username)).catch(() => null);
  if (!info) {
    updateState(username, { status: "unknown", containerId: undefined, health: null, healthCheckedAt: Date.now() }, cfg);
    return instances.get(username);
  }
  if (!info.State.Running) {
    updateState(username, { status: "stopped", containerId: info.Id, health: null, healthCheckedAt: Date.now() }, cfg);
    return instances.get(username);
  }

  const health = await fetchSupervisorHealth(username);
  const serving = health?.ok === true;
  const previous = instances.get(username)?.status;
  updateState(username, {
    containerId: info.Id,
    status: serving ? "running" : "unhealthy",
    health: health ?? null,
    healthCheckedAt: Date.now(),
    ...(serving ? { error: undefined } : {}),
  }, cfg);

  // Log only on transitions, so the log records incidents instead of noise.
  if (!serving && previous === "running") {
    const detail = health
      ? `base state=${health.base?.state ?? "?"} procAlive=${health.base?.procAlive ?? "?"}` +
        (health.supervision?.lastExit ? ` lastExit=${health.supervision.lastExit.signal ?? `code ${health.supervision.lastExit.code}`}${health.supervision.lastExit.oomSuspected ? " (OOM suspected)" : ""}` : "")
      : "supervisor unreachable";
    log(username, `Container is UP but BOS is not serving — ${detail}`, cfg);
  } else if (serving && previous === "unhealthy") {
    log(username, "BOS is serving again.", cfg);
  }
  return instances.get(username);
}

export function getInstanceState(username: string): InstanceState | undefined {
  return instances.get(username);
}

export function getAllInstances(): InstanceState[] {
  return [...instances.values()];
}

export async function reconcileOnStartup(cfg: Config): Promise<void> {
  const running = await listBosContainers();
  for (const c of running) {
    const username = c.name.replace(/^bos-/, "");
    // Proactively repair a stale bos-net attachment (most commonly left behind
    // by a `docker compose down`/`up` cycle recreating the network with a new
    // ID) before any login attempt can reach this container. Best-effort: if
    // it fails, getOrProvision's existing recreate-and-heal fallback still
    // covers it on first use. See 024 FR-019.
    await reconcileNetworkAttachment(c.id, cfg.bosNet).catch((err) => {
      console.error(`[bastion] [${username}] startup network reconcile failed (non-fatal):`, err);
    });
    const status: InstanceStatus = c.status === "running" ? "running" : "stopped";
    updateState(username, { containerId: c.id, status, lastActive: Date.now() }, cfg);
  }
  // Anything in our map with no matching Docker container is truly gone.
  for (const [username] of instances) {
    const found = running.find((c) => c.name === `bos-${username}`);
    if (!found) updateState(username, { containerId: undefined, status: "unknown" }, cfg);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function updateState(username: string, patch: Partial<InstanceState>, cfg: Config, opts: { coalesce?: boolean } = {}): void {
  const prev = instances.get(username) ?? { username, status: "unknown" as InstanceStatus, lastActive: 0 };
  instances.set(username, { ...prev, ...patch, username });
  if (opts.coalesce) schedulePersist(cfg);
  else persistInstancesToDisk(cfg);
}

// A cosmetic "last active" touch arrives on EVERY proxied request — every page,
// every asset, every poll. Rewriting the whole registry that often is pointless
// on its own, and it is how a disk-space problem reached the request path at
// all. Meaningful transitions (provisioned, started, stopped, health) still
// persist immediately; only the timestamp is coalesced, leading-edge so the
// first touch after a quiet period is recorded at once.
const PERSIST_COALESCE_MS = 5_000;
let lastPersistAt = 0;
let pendingPersist: NodeJS.Timeout | null = null;

function schedulePersist(cfg: Config): void {
  const since = Date.now() - lastPersistAt;
  if (since >= PERSIST_COALESCE_MS) {
    persistInstancesToDisk(cfg);
    return;
  }
  if (pendingPersist) return;
  pendingPersist = setTimeout(() => {
    pendingPersist = null;
    persistInstancesToDisk(cfg);
  }, PERSIST_COALESCE_MS - since);
  pendingPersist.unref?.();
}

/**
 * Write the instance registry atomically: a temp file in the same directory,
 * then `rename` onto the target.
 *
 * This used to be a bare `fs.writeFileSync`, whose `O_TRUNC` empties the file
 * BEFORE the write is attempted. When the production host hit its disk quota,
 * the truncate succeeded and the write did not, so `/data/instances.json` was
 * left at zero bytes — and because the call sat under `routeToUser ->
 * touchInstance`, the same failure threw out of the proxy middleware and
 * served an "Unknown system error -122" stack trace to every user on every
 * page. `rename` is atomic within a directory: the registry is either the old
 * content or the new one, never a truncated middle.
 *
 * The failure is CONTAINED rather than propagated, deliberately: this file is
 * a cache, rebuilt from `docker ps` by reconcileOnStartup on every boot, and
 * its most frequent writer is a cosmetic timestamp in the request path.
 * Nothing a user is doing should fail because the admin UI's "last active"
 * column could not be updated. Contained is not silent — every failure is
 * reported with its cause.
 */
let persistSeq = 0;
function persistInstancesToDisk(cfg: Config): void {
  const file = path.join(cfg.dataDir, "instances.json");
  const tmp = `${file}.tmp-${process.pid}-${++persistSeq}`;
  lastPersistAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...instances.values()], null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[bastion] could not persist the instance registry to ${file} — in-memory state is unaffected and reconcileOnStartup will rebuild it from Docker on the next boot:`, err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanupErr) {
      console.error(`[bastion] and its staging file ${tmp} could not be removed either:`, cleanupErr);
    }
  }
}

function loadInstancesFromDisk(cfg: Config): void {
  const file = path.join(cfg.dataDir, "instances.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as InstanceState[];
    for (const s of data) {
      // Load as "unknown" — reconcileOnStartup will correct the status.
      instances.set(s.username, { ...s, status: "unknown" });
    }
  } catch { /* no file yet */ }
}
