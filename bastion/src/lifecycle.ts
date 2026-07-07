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

// Module-level state
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
  // Prevent concurrent provisions for the same user
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

  if (state?.status === "running") {
    resetIdleTimer(username, cfg);
    return;
  }

  if (state?.status === "stopped" && state.containerId) {
    await startContainer(state.containerId);
    await waitForHealthy(username, 60_000);
    updateState(username, { status: "running", lastActive: Date.now() }, cfg);
    resetIdleTimer(username, cfg);
    return;
  }

  // Not provisioned or unknown — check Docker reality first
  const info = await inspectContainer(containerName(username));
  if (info) {
    const cid = info.Id;
    if (info.State.Running) {
      updateState(username, { containerId: cid, status: "running", lastActive: Date.now() }, cfg);
      resetIdleTimer(username, cfg);
      return;
    }
    // Container exists but stopped
    await startContainer(cid);
    await waitForHealthy(username, 60_000);
    updateState(username, { containerId: cid, status: "running", lastActive: Date.now() }, cfg);
    resetIdleTimer(username, cfg);
    return;
  }

  // Check capacity
  const running = [...instances.values()].filter((s) => s.status === "running").length;
  if (running >= cfg.maxConcurrentInstances) {
    throw new Error(`Max concurrent instances (${cfg.maxConcurrentInstances}) reached`);
  }

  // Full provision
  updateState(username, { status: "provisioning", lastActive: Date.now() }, cfg);
  try {
    const containerId = await provisionUser(username, cfg);
    // 5 min: npm install (if volume is cold) + supervisor startup + next dev startup
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

  // Update lastActive
  const state = instances.get(username);
  if (state) {
    updateState(username, { lastActive: Date.now() }, cfg);
  }
}

export async function stopInstance(username: string): Promise<void> {
  const state = instances.get(username);
  if (!state?.containerId) return;
  await stopContainer(state.containerId).catch(console.error);
  updateState(username, { status: "stopped" }, _cfg);
  const timer = idleTimers.get(username);
  if (timer) { clearTimeout(timer); idleTimers.delete(username); }
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
    if (!instances.has(username)) {
      updateState(username, { containerId: c.id, status, lastActive: Date.now() }, cfg);
    } else {
      updateState(username, { containerId: c.id, status }, cfg);
    }
    if (status === "running") resetIdleTimer(username, cfg);
  }
  // Mark anything in our map that Docker doesn't know about as unknown
  for (const [username, state] of instances) {
    const found = running.find((c) => c.name === `bos-${username}`);
    if (!found && state.status !== "unknown") {
      updateState(username, { status: "unknown" }, cfg);
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function updateState(
  username: string,
  patch: Partial<InstanceState>,
  cfg: Config,
): void {
  const prev = instances.get(username) ?? { username, status: "unknown" as InstanceStatus, lastActive: 0 };
  instances.set(username, { ...prev, ...patch, username });
  persistInstancesToDisk(cfg);
}

function persistInstancesToDisk(cfg: Config): void {
  const file = path.join(cfg.dataDir, "instances.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = [...instances.values()];
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadInstancesFromDisk(cfg: Config): void {
  const file = path.join(cfg.dataDir, "instances.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as InstanceState[];
    for (const s of data) {
      instances.set(s.username, { ...s, status: "unknown" }); // will be reconciled
    }
  } catch { /* no file yet */ }
}
