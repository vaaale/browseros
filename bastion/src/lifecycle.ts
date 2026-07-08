import fs from "fs";
import path from "path";
import type { Config } from "./config";
import {
  containerName,
  startContainer,
  stopContainer,
  inspectContainer,
  listBosContainers,
  waitForHealthy,
} from "./docker";
import { provisionUser } from "./provision";

export type InstanceStatus = "running" | "stopped" | "provisioning" | "unknown";

export interface InstanceState {
  username: string;
  containerId?: string;
  status: InstanceStatus;
  lastActive: number;
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
  const info = await inspectContainer(containerName(username));

  if (info) {
    const cid = info.Id;
    if (info.State.Running) {
      // Container is running — health-gate before declaring ready so we don't
      // mark it "running" while the supervisor / Next.js is still starting up.
      updateState(username, { containerId: cid, status: "provisioning", lastActive: Date.now() }, cfg);
      await waitForHealthy(username, 300_000);
      updateState(username, { containerId: cid, status: "running", lastActive: Date.now() }, cfg);
      resetIdleTimer(username, cfg);
      return;
    }
    // Container exists but is stopped — start it.
    updateState(username, { containerId: cid, status: "stopped" }, cfg);
    await startContainer(cid);
    await waitForHealthy(username, 300_000);
    updateState(username, { containerId: cid, status: "running", lastActive: Date.now() }, cfg);
    resetIdleTimer(username, cfg);
    return;
  }

  // No container at all — full provision.
  const runningCount = [...instances.values()].filter((s) => s.status === "running").length;
  if (runningCount >= cfg.maxConcurrentInstances) {
    throw new Error(`Max concurrent instances (${cfg.maxConcurrentInstances}) reached`);
  }

  updateState(username, { status: "provisioning", lastActive: Date.now() }, cfg);
  try {
    const containerId = await provisionUser(username, cfg);
    // 5 min: docker volume copy + supervisor + next dev compile
    await waitForHealthy(username, 300_000);
    updateState(username, { containerId, status: "running", lastActive: Date.now() }, cfg);
    resetIdleTimer(username, cfg);
  } catch (err) {
    updateState(username, { status: "unknown", lastActive: Date.now() }, cfg);
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
