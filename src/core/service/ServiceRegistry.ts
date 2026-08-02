import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";
import { isInstalled } from "@/system/marketplace/install/symlinkManager";
import { listInstalledItems, itemConfigDir, itemLinkPath } from "@/system/items/installed";
import { validateManifest } from "./manifestValidator";
import type { ServiceManifest, ServiceDefinition, ServiceState, ServiceRegistryEvent } from "./types";

const COMPONENT = "services.registry";
const MAX_EVENTS = 2_000;

interface StampedEvent {
  seq: number;
  ts: number;
  event: ServiceRegistryEvent;
}

export interface SourceItem {
  id: string;
  itemPath: string;
  manifest: ServiceManifest;
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

async function readManifestAt(itemPath: string): Promise<ServiceManifest | null> {
  const manifestPath = path.join(itemPath, "services", "service.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as ServiceManifest;
    const result = await validateManifest(parsed);
    if (!result.valid) {
      logger().warn(COMPONENT, `invalid service.json at ${manifestPath}`, { errors: result.errors });
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * ServiceRegistry — discovers service items on disk, tracks the "installed"
 * (symlinked) vs "source" (discovered but not installed) split, holds the
 * live runtime state for installed services (state/worker/restartCount/bound
 * port), and broadcasts state changes as events for the Settings UI and the
 * ServiceManager's own bookkeeping. Single source of truth for `state` — the
 * ServiceManager mutates it via the setters below rather than keeping its own
 * copy, so registry reads are always current.
 */
export class ServiceRegistry {
  private definitions = new Map<string, ServiceDefinition>();
  private sourceItems = new Map<string, SourceItem>();
  private listeners = new Set<(e: ServiceRegistryEvent) => void>();
  private eventLog: StampedEvent[] = [];
  private seq = 0;
  private initialized = false;

  /** Scan dataDir()/user-apps/ and dataDir()/marketplace/<id>/items/ for items
   *  exposing services/service.json. Refreshes both the source-item list and,
   *  for anything with an active dataDir()/system/services/<id> symlink, the
   *  installed definitions map (preserving live runtime fields on refresh). */
  async discoverServices(): Promise<void> {
    const found = new Map<string, SourceItem>();

    // user-apps is a marketplace repo like any other: items under items/ (034 FR-001).
    const userAppsRoot = path.join(dataDir(), "user-apps", "items");
    for (const itemPath of await listDirs(userAppsRoot)) {
      const manifest = await readManifestAt(itemPath);
      if (manifest) found.set(manifest.id, { id: manifest.id, itemPath, manifest });
    }

    const marketplaceRoot = path.join(dataDir(), "marketplace");
    for (const marketplaceDir of await listDirs(marketplaceRoot)) {
      const itemsRoot = path.join(marketplaceDir, "items");
      for (const itemPath of await listDirs(itemsRoot)) {
        const manifest = await readManifestAt(itemPath);
        if (manifest && !found.has(manifest.id)) {
          found.set(manifest.id, { id: manifest.id, itemPath, manifest });
        }
      }
    }

    this.sourceItems = found;

    // Installed services come from the ONE shared installed-item scan (035
    // FR-007) — an item is an installed service when it has a services/ facet.
    // Never scan the install root here independently: a second, subtly different
    // scan is exactly how this registry and the marketplace client previously
    // disagreed about what existed.
    const installed = (await listInstalledItems()).filter((i) => i.facets.service);
    const installedIds = new Set(installed.map((i) => i.id));
    const installedPathById = new Map(installed.map((i) => [i.id, i.itemPath]));
    for (const id of installedIds) {
      const resolvedManifest = await this.readInstalledManifest(id);
      const existing = this.definitions.get(id);
      const wasCorrupted = existing?.state === "corrupted";
      const itemPath = installedPathById.get(id) ?? found.get(id)?.itemPath ?? existing?.itemPath ?? "";

      if (!resolvedManifest) {
        this.definitions.set(id, {
          id,
          manifest: existing?.manifest ?? ({ id, name: id, version: "0.0.0", entry: "index.js" } as ServiceManifest),
          state: "corrupted",
          worker: existing?.worker ?? null,
          configDirPath: itemConfigDir(id),
          logsPath: path.join(dataDir(), "logs", "services", `${id}.log`),
          restartCount: existing?.restartCount ?? 0,
          boundPort: existing?.boundPort ?? null,
          boundHost: existing?.boundHost ?? null,
          installed: true,
          itemPath,
          corruptedReason: "service.json is missing or invalid",
        });
        // Only emit on the actual stopped/running -> corrupted transition —
        // discoverServices() re-runs on every GET /api/services poll, and
        // re-emitting every scan would spam the Settings UI event stream.
        if (!wasCorrupted) {
          logger().error(COMPONENT, `service "${id}" is corrupted — service.json is missing or invalid`, undefined, { serviceId: id });
          this.emit({ type: "service:status:changed", id, state: "corrupted" });
        }
        continue;
      }

      // A manifest that resolves again after being corrupted means the file
      // was restored — recover to "stopped" so the service can be started
      // again. Per spec this is the ONLY way out of "corrupted": there is no
      // automatic restart, the user must explicitly start it once recovered.
      const nextState: ServiceState = wasCorrupted ? "stopped" : (existing?.state ?? "stopped");
      this.definitions.set(id, {
        id,
        manifest: resolvedManifest,
        state: nextState,
        worker: existing?.worker ?? null,
        configDirPath: itemConfigDir(id),
        logsPath: path.join(dataDir(), "logs", "services", `${id}.log`),
        restartCount: existing?.restartCount ?? 0,
        boundPort: existing?.boundPort ?? null,
        boundHost: existing?.boundHost ?? null,
        installed: true,
        itemPath,
        corruptedReason: undefined,
      });
      if (wasCorrupted) {
        logger().info(COMPONENT, `service "${id}" manifest restored — no longer corrupted`, { serviceId: id });
        this.emit({ type: "service:status:changed", id, state: nextState });
      }
    }

    // Drop definitions whose symlink disappeared outside of uninstallService
    // (e.g. manual filesystem edits) so getAllServices() stays accurate.
    for (const id of this.definitions.keys()) {
      if (!installedIds.has(id)) this.definitions.delete(id);
    }
  }

  private async readInstalledManifest(id: string): Promise<ServiceManifest | null> {
    const manifestPath = path.join(itemLinkPath(id), "services", "service.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      return JSON.parse(raw) as ServiceManifest;
    } catch {
      return null;
    }
  }

  /** Initial scan at boot. Idempotent. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.discoverServices();
    this.initialized = true;
    logger().info(COMPONENT, "initialized", {
      installed: [...this.definitions.keys()],
      source: [...this.sourceItems.keys()].filter((id) => !this.definitions.has(id)),
    });
  }

  /** Items with a service.json manifest but no active install symlink. */
  getSourceServices(): SourceItem[] {
    return [...this.sourceItems.values()].filter((item) => !this.definitions.has(item.id));
  }

  /** All known services — installed (full runtime state) + source-only (prospective). */
  getAllServices(): ServiceDefinition[] {
    const installed = [...this.definitions.values()];
    const sourceOnly: ServiceDefinition[] = this.getSourceServices().map((item) => ({
      id: item.id,
      manifest: item.manifest,
      state: "stopped" as ServiceState,
      worker: null,
      configDirPath: itemConfigDir(item.id),
      logsPath: path.join(dataDir(), "logs", "services", `${item.id}.log`),
      restartCount: 0,
      boundPort: null,
      boundHost: null,
      installed: false,
      itemPath: item.itemPath,
    }));
    return [...installed, ...sourceOnly];
  }

  getService(serviceId: string): ServiceDefinition | undefined {
    return this.definitions.get(serviceId);
  }

  /** Register (or refresh) an installed service. Called by serviceInstaller
   *  right after symlinks are created and the manifest validated. */
  registerInstalled(id: string, manifest: ServiceManifest, itemPath: string): void {
    const existing = this.definitions.get(id);
    this.definitions.set(id, {
      id,
      manifest,
      state: existing?.state ?? "stopped",
      worker: existing?.worker ?? null,
      configDirPath: itemConfigDir(id),
      logsPath: path.join(dataDir(), "logs", "services", `${id}.log`),
      restartCount: existing?.restartCount ?? 0,
      boundPort: existing?.boundPort ?? null,
      boundHost: existing?.boundHost ?? null,
      installed: true,
      itemPath,
    });
  }

  unregisterInstalled(id: string): void {
    this.definitions.delete(id);
  }

  setState(id: string, state: ServiceState, error?: string): void {
    const def = this.definitions.get(id);
    if (!def) return;
    def.state = state;
    def.lastError = error;
    this.emit({ type: "service:status:changed", id, state, error });
  }

  setWorker(id: string, worker: ServiceDefinition["worker"]): void {
    const def = this.definitions.get(id);
    if (def) def.worker = worker;
  }

  setBound(id: string, port: number, host: string): void {
    const def = this.definitions.get(id);
    if (!def) return;
    def.boundPort = port;
    def.boundHost = host;
    this.emit({ type: "service:bound", id, port, host });
  }

  incrementRestart(id: string): number {
    const def = this.definitions.get(id);
    if (!def) return 0;
    def.restartCount += 1;
    return def.restartCount;
  }

  resetRestart(id: string): void {
    const def = this.definitions.get(id);
    if (def) def.restartCount = 0;
  }

  markCorrupted(id: string, reason: string): void {
    const def = this.definitions.get(id);
    if (!def) return;
    def.state = "corrupted";
    def.corruptedReason = reason;
    this.emit({ type: "service:status:changed", id, state: "corrupted" });
  }

  /** True if `serviceId` currently has an active install symlink. */
  async isInstalled(serviceId: string): Promise<boolean> {
    return isInstalled(serviceId);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  emit(event: ServiceRegistryEvent): void {
    const stamped: StampedEvent = { seq: ++this.seq, ts: Date.now(), event };
    this.eventLog.push(stamped);
    if (this.eventLog.length > MAX_EVENTS) this.eventLog.splice(0, this.eventLog.length - MAX_EVENTS);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never affect the registry.
      }
    }
  }

  on(callback: (e: ServiceRegistryEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  off(callback: (e: ServiceRegistryEvent) => void): void {
    this.listeners.delete(callback);
  }

  /** Replay events with seq > since, then tail live — mirrors RunManager's
   *  subscribe() for the /api/services/events NDJSON stream. */
  subscribe(since: number, onEvent: (e: ServiceRegistryEvent, seq: number, ts: number) => void): () => void {
    for (const stamped of this.eventLog) {
      if (stamped.seq > since) onEvent(stamped.event, stamped.seq, stamped.ts);
    }
    const wrapped = (e: ServiceRegistryEvent) => {
      const stamped = this.eventLog[this.eventLog.length - 1];
      onEvent(e, stamped?.seq ?? this.seq, stamped?.ts ?? Date.now());
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }
}

// Hot-reload-safe singleton (same pattern as RunManager / PluginRegistry).
const g = globalThis as unknown as { __bosServiceRegistry?: ServiceRegistry };

export function serviceRegistry(): ServiceRegistry {
  if (!g.__bosServiceRegistry) {
    g.__bosServiceRegistry = new ServiceRegistry();
  }
  return g.__bosServiceRegistry;
}
