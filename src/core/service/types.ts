// Service daemon types — framework-free (no server-only import), shared between
// server-side registry/manager code, worker entrypoints, and the Settings UI.
// See user-specs/002-service-daemons/spec.md for the full architecture.

import type { Worker } from "node:worker_threads";

// ── Manifest (services/<id>/service.json) ──────────────────────────────────

export interface ServiceSettingsRegistration {
  label: string;
  icon?: string;
  order?: number;
  /** If set, the Settings UI renders this custom config app instead of the
   *  default JSON-Schema-driven config panel. */
  configApp?: string;
}

export interface ServiceManifest {
  /** Unique service identifier — must match the containing directory name. */
  id: string;
  name: string;
  /** Semver version string. */
  version: string;
  description?: string;
  /** Path to the entrypoint (JS/TS file), relative to the services/<id>/ dir. */
  entry: string;
  /** Optional JSON Schema describing the service's user-configurable settings. */
  configSchema?: Record<string, unknown>;
  /** Service IDs that must be running before this service starts. */
  dependencies?: string[];
  settingsRegistration?: ServiceSettingsRegistration;
}

// ── Runtime state ────────────────────────────────────────────────────────────

export type ServiceState = "stopped" | "running" | "restarting" | "crashed" | "corrupted";

export interface ServiceDefinition {
  id: string;
  manifest: ServiceManifest;
  state: ServiceState;
  /** The live worker thread, present only while state is "running"/"restarting". */
  worker: Worker | null;
  /** Absolute path to dataDir()/config/<id> (symlink to the item's config/). */
  configDirPath: string;
  /** Absolute path to dataDir()/logs/services/<id>.log. */
  logsPath: string;
  /** Consecutive crash count since the last clean start; resets on `initialized`. */
  restartCount: number;
  /** Discovered from the worker's `bound` message, if the service binds a port. */
  boundPort: number | null;
  boundHost: string | null;
  /** True once dataDir()/system/services/<id> symlink exists (installed vs source). */
  installed: boolean;
  /** Absolute path to the source item directory (user-apps/<id> or marketplace clone). */
  itemPath: string;
  /** Set when service.json could not be (re-)loaded after install (FR error handling). */
  corruptedReason?: string;
}

export interface CrashRecoveryPolicy {
  /** Maximum number of restart attempts before stopping permanently. Default 5. */
  maxRestarts: number;
  /** Initial backoff in milliseconds. Default 1000. */
  backoffMs: number;
  /** Exponential backoff multiplier. Default 2. */
  backoffMultiplier: number;
}

export const DEFAULT_CRASH_RECOVERY_POLICY: CrashRecoveryPolicy = {
  maxRestarts: 5,
  backoffMs: 1000,
  backoffMultiplier: 2,
};

/** CH-015 — configurable start/stop timeouts. 0 disables waiting. */
export interface ServiceTimeouts {
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_SERVICE_TIMEOUTS: ServiceTimeouts = {
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 30_000,
};

// ── Worker IPC protocol ──────────────────────────────────────────────────────

export type MainToWorkerMessage =
  | { type: "initialize"; configDirPath: string; logsPath: string; serviceId: string }
  | { type: "dispose" }
  | { type: "restart"; reason: string };

export type WorkerToMainMessage =
  | { type: "initialized" }
  | { type: "bound"; port: number; host: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "disposed" }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "crash"; error: string; stack?: string };

// ── Runtime state file (dataDir()/config/<id>/runtime.json) ─────────────────
// Written by the service manager after a `bound` message. Separate from the
// item's own user config files — never user-edited.

export interface RuntimeState {
  port: number;
  host: string;
}

// ── Settings UI status shape (served over /api/services + /api/services/events) ─

export interface ServiceStatusView {
  id: string;
  manifest: ServiceManifest;
  state: ServiceState;
  installed: boolean;
  restartCount: number;
  boundPort: number | null;
  boundHost: string | null;
  corruptedReason?: string;
}

/** Shared mapper from internal runtime state to the shape served over
 *  /api/services + /api/services/[id] + /api/services/events. */
export function toServiceStatusView(def: ServiceDefinition): ServiceStatusView {
  return {
    id: def.id,
    manifest: def.manifest,
    state: def.state,
    installed: def.installed,
    restartCount: def.restartCount,
    boundPort: def.boundPort,
    boundHost: def.boundHost,
    corruptedReason: def.corruptedReason,
  };
}

export type ServiceRegistryEvent =
  | { type: "service:status:changed"; id: string; state: ServiceState }
  | { type: "service:crash"; id: string; error: string; stack?: string; restartCount: number }
  | { type: "service:bound"; id: string; port: number; host: string }
  | { type: "service:installed"; id: string }
  | { type: "service:uninstalled"; id: string };
