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
  waitForHealthy,
} from "./docker";
import { provisionUser } from "./provision";
import * as logStore from "./log-store";

export type InstanceStatus = "running" | "stopped" | "provisioning" | "unknown";

export interface InstanceState {
  username: string;
  containerId?: string;
  status: InstanceStatus;
  lastActive: number;
  provisionLog?: string;
  provisionError?: string;
  /** Short human-readable reason for the last failure. */
  error?: string;
}

const instances = new Map<string, InstanceState>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<void>>();

let _cfg: Config;

export function initLifecycle(cfg: Config): void {
  _cfg = cfg;
  loadInstancesFromDisk(cfg);
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
  const newId = await createBosContainer(username, cfg);
  await startContainer(newId);
  updateState(username, { containerId: newId, status: "provisioning", provisionError: undefined, lastActive: Date.now() }, cfg);
  await waitForHealthy(username, 300_000);
  return newId;
}

async function _getOrProvision(username: string, cfg: Config): Promise<void> {
  const state = instances.get(username);

  // Fast path: already confirmed running — skip Docker round-trip.
  if (state?.status === "running") {
    resetIdleTimer(username, cfg);
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
        await waitForHealthy(username, 300_000);
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
      resetIdleTimer(username, cfg);
      return;
    }
    // Container exists but is stopped — start it.
    log(username, "Container is stopped — starting…", cfg);
    updateState(username, { containerId: cid, status: "stopped", provisionError: undefined }, cfg);
    try {
      await startContainer(cid);
      log(username, "Container started — waiting for supervisor and Next.js to become healthy (npm install may run)…", cfg);
      await waitForHealthy(username, 300_000);
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
    resetIdleTimer(username, cfg);
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
    const containerId = await provisionUser(username, cfg);
    log(username, "Container created — waiting for supervisor and Next.js to become healthy (npm install will run on first start)…", cfg);
    await waitForHealthy(username, 300_000);
    log(username, "Instance is ready!", cfg);
    updateState(username, { containerId, status: "running", error: undefined, lastActive: Date.now() }, cfg);
    resetIdleTimer(username, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? msg) : msg;
    console.error(`[bastion] [${username}] Provision failed:`, stack);
    logStore.append(username, `ERROR (provision): ${stack}`);
    updateState(username, { status: "unknown", provisionError: stack, error: msg, lastActive: Date.now() }, cfg);
    throw err;
  }
}

export function resetIdleTimer(username: string, cfg: Config): void {
  const existing = idleTimers.get(username);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    await stopInstance(username).catch(console.error);
  }, cfg.idleTimeoutMs);

  idleTimers.set(username, timer);

  const state = instances.get(username);
  if (state) updateState(username, { lastActive: Date.now() }, cfg);
}

export async function stopInstance(username: string): Promise<void> {
  // Re-inspect by name so we use the current container ID, not a stale one.
  const info = await inspectContainer(containerName(username)).catch(() => null);
  if (info?.State.Running) {
    await stopContainer(info.Id).catch(console.error);
  }
  updateState(username, { status: "stopped" }, _cfg);
  const timer = idleTimers.get(username);
  if (timer) { clearTimeout(timer); idleTimers.delete(username); }
}

/** Clear a user's lifecycle state so the next getOrProvision re-checks Docker
 *  from scratch. Call this after any re-provision operation. */
export function clearInstanceState(username: string): void {
  const timer = idleTimers.get(username);
  if (timer) { clearTimeout(timer); idleTimers.delete(username); }
  instances.delete(username);
  if (_cfg) persistInstancesToDisk(_cfg);
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
    const status: InstanceStatus = c.status === "running" ? "running" : "stopped";
    updateState(username, { containerId: c.id, status, lastActive: Date.now() }, cfg);
    if (status === "running") resetIdleTimer(username, cfg);
  }
  // Anything in our map with no matching Docker container is truly gone.
  for (const [username] of instances) {
    const found = running.find((c) => c.name === `bos-${username}`);
    if (!found) updateState(username, { containerId: undefined, status: "unknown" }, cfg);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function updateState(username: string, patch: Partial<InstanceState>, cfg: Config): void {
  const prev = instances.get(username) ?? { username, status: "unknown" as InstanceStatus, lastActive: 0 };
  instances.set(username, { ...prev, ...patch, username });
  persistInstancesToDisk(cfg);
}

function persistInstancesToDisk(cfg: Config): void {
  const file = path.join(cfg.dataDir, "instances.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...instances.values()], null, 2));
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
