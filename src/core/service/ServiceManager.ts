import "server-only";
import { Worker } from "node:worker_threads";
import { promises as fs } from "fs";
import path from "path";
import { logger } from "@/lib/logging";
import { writeFileAtomic } from "@/os/atomic-write";
import { serviceRegistry } from "./ServiceRegistry";
import { itemLinkPath } from "@/system/items/installed";
import { checkPortAvailable, checkPortReservedByBos } from "./PortChecker";
import { validateManifestAtStart } from "./manifestValidator";
import { checkDependenciesRunning, resolveOrder } from "./DependencyResolver";
import { cancelPendingRestart, handleCrash } from "./CrashRecovery";
import { postMessage, waitForMessage, sendToolCall, waitForToolResult, sendEventDispatch } from "./workerIpc";
import { DEFAULT_SERVICE_TIMEOUTS } from "./types";
import type { ServiceState, WorkerToMainMessage } from "./types";
import { serviceToolBridge } from "@/lib/agent/service-tool-bridge";
import { LOG as TOOL_LOG } from "./serviceToolTypes";
import * as eventsApi from "@/lib/events/api";
import { setOwnerRunningCheck, setServiceInvoker, reevaluateAllPending } from "@/lib/events/dispatch";
import { reevaluateAfterOwnerStarted } from "@/lib/events/kernel";

const EVENTS_LOG = "services.events-bridge";

const COMPONENT = "services.manager";
// 039-service-tool-exposure: how long BOS waits for a service's `tool_result`/
// `tool_error` after dispatching a `tool_call`, before treating the call as
// failed. Distinct from the manifest's own start/stop timeouts.
const TOOL_CALL_TIMEOUT_MS = 30_000;
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 };

// Turbopack (unlike webpack's `webpackIgnore` comment, which works for
// import()/require()) intercepts every literal `new Worker(...)` call site
// and tries to statically resolve its first argument as a bundlable module —
// for entryPath (a runtime-computed path to a user-installed service item,
// entirely outside the bundle) that fails at runtime with "Cannot find module
// 'unknown'", even though the exact same path works fine via plain Node.
// Building the constructor call from a string (so this file never contains a
// literal `new Worker(` for Turbopack's parser to see) is the only reliable
// way around it.
const createNodeWorker = new Function(
  "WorkerCtor",
  "entryPath",
  "options",
  "return new WorkerCtor(entryPath, options);",
) as (WorkerCtor: typeof Worker, entryPath: string, options: import("node:worker_threads").WorkerOptions) => Worker;

export interface StartOptions {
  startupTimeout?: number;
}

export interface StopOptions {
  shutdownTimeout?: number;
}

async function readConfiguredPort(configDirPath: string, serviceId: string): Promise<{ port: number; host: string } | null> {
  try {
    const raw = await fs.readFile(path.join(configDirPath, `${serviceId}.json`), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config.port === "number") {
      return { port: config.port, host: typeof config.host === "string" ? config.host : "localhost" };
    }
  } catch {
    // No config file yet, or it doesn't declare a port — nothing to pre-check.
  }
  return null;
}

async function appendServiceLog(logsPath: string, text: string): Promise<void> {
  if (!text) return;
  try {
    await fs.mkdir(path.dirname(logsPath), { recursive: true });
    await fs.appendFile(logsPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  } catch (err) {
    logger().warn(COMPONENT, "failed to append service log", { logsPath, error: (err as Error).message });
  }
}

/** CH-005/CH-002 — write the service's runtime (manager-owned) binding state,
 *  separate from its user config file. Atomic write prevents a dependent
 *  service from reading a half-written file. */
async function writeRuntimeState(configDirPath: string, port: number, host: string): Promise<void> {
  await writeFileAtomic(path.join(configDirPath, "runtime.json"), JSON.stringify({ port, host }, null, 2));
}

/**
 * ServiceManager — creates and controls the worker thread behind each
 * installed service, implements the Start/Stop/Restart lifecycle operations,
 * and wires worker exit/error/message events into crash recovery. The
 * ServiceRegistry is the single source of truth for `state`/`worker`/
 * `restartCount`/bound port; this class only mutates it via registry setters.
 */
const MAX_BOOT_START_ATTEMPTS = 3;

export class ServiceManager {
  /** Services currently being torn down deliberately (Stop/timeout-terminate)
   *  — their `exit` event must NOT be treated as a crash. */
  private expectingExit = new Set<string>();

  /** Per-service start-attempt counter, tracked ONLY during startAll() (boot).
   *  Cleared at the start and end of every startAll() run — manual start()/
   *  restart() calls never touch this and always retry unconditionally. */
  private bootAttempts = new Map<string, number>();

  constructor() {
    // 039-service-tool-exposure — wire the bridge's dispatcher every time a
    // ServiceManager is constructed (not just for the module singleton, since
    // tests construct `new ServiceManager()` directly). Idempotent: re-wiring
    // just replaces the closure, which always resolves the Worker via
    // serviceRegistry() at CALL time, not at wiring time, so it's correct
    // regardless of which ServiceManager instance ends up starting a service.
    serviceToolBridge().setDispatcher(async (serviceId, invocation, signal) => {
      const worker = serviceRegistry().getService(serviceId)?.worker;
      if (!worker) {
        return {
          callId: invocation.callId,
          error: { code: "service_not_running", message: `service "${serviceId}" is not running` },
        };
      }
      sendToolCall(worker, invocation);
      return waitForToolResult(worker, invocation.callId, TOOL_CALL_TIMEOUT_MS, signal);
    });

    // 034-event-notification-system (T029) — same wiring shape as the tool
    // bridge above: the dispatch engine never imports ServiceManager (it would
    // be a cycle), so it calls back through these two injected functions
    // instead. `setOwnerRunningCheck` feeds the active-set rule (data-model
    // §4); `setServiceInvoker` only confirms the `event_dispatch` IPC message
    // was sent — settlement arrives later via the worker's own loopback ack
    // (design.md §3.5 "Ack ownership", R1), not a reply on this channel.
    setOwnerRunningCheck((ownerId) => serviceRegistry().getService(ownerId)?.state === "running");
    setServiceInvoker(async (ownerId, handlerId, record, _timeoutMs, callId) => {
      const worker = serviceRegistry().getService(ownerId)?.worker;
      if (!worker) throw new Error(`service "${ownerId}" is not running`);
      sendEventDispatch(worker, { callId, eventId: record.id, handlerId, record });
    });
  }

  /** 039-service-tool-exposure — remove every tool a service registered via
   *  the bridge (a no-op if it registered none) and log a summary event.
   *  Called from every lifecycle path that ends a service's worker: stop and
   *  crash (unexpected worker exit). The bridge itself logs `tool:unregistered`
   *  per removed tool; this adds the `worker:exit-cleanup` summary. */
  private cleanupServiceTools(serviceId: string): void {
    const toolCount = serviceToolBridge().serviceToolsFor(serviceId).length;
    if (toolCount === 0) return;
    serviceToolBridge().unregisterServiceTools(serviceId);
    logger().info(TOOL_LOG, "worker:exit-cleanup", { serviceId, toolCount });
  }

  getStatus(serviceId: string): ServiceState {
    return serviceRegistry().getService(serviceId)?.state ?? "stopped";
  }

  getWorker(serviceId: string): Worker | null {
    return serviceRegistry().getService(serviceId)?.worker ?? null;
  }

  /** Start lifecycle operation (spec "Lifecycle operations" §1). */
  async start(serviceId: string, options: StartOptions = {}): Promise<void> {
    const registry = serviceRegistry();
    const def = registry.getService(serviceId);
    if (!def) {
      logger().warn(COMPONENT, `start: unknown service "${serviceId}"`, { serviceId });
      return;
    }
    if (def.state === "running" || def.state === "restarting") {
      logger().warn(COMPONENT, `start: service "${serviceId}" is already ${def.state}`, { serviceId });
      return;
    }
    if (def.state === "corrupted") {
      logger().error(COMPONENT, `start: service "${serviceId}" is corrupted — refusing to start`, undefined, {
        serviceId,
        reason: def.corruptedReason,
      });
      return;
    }

    cancelPendingRestart(serviceId);

    // 1. Validate manifest can actually be loaded (CH-011 at-start check).
    // Resolve through the item symlink (035): dataDir()/system/<id>/services/
    const serviceDir = path.join(itemLinkPath(serviceId), "services");
    const startValidation = await validateManifestAtStart(def.manifest, serviceDir);
    if (!startValidation.valid) {
      const message = `Manifest validation failed: ${startValidation.errors.join("; ")}`;
      logger().error(COMPONENT, `start: manifest validation failed for "${serviceId}"`, undefined, {
        serviceId,
        errors: startValidation.errors,
      });
      registry.setState(serviceId, "stopped", message);
      return;
    }

    // 2. Resolve entrypoint path.
    const entryPath = path.resolve(itemLinkPath(serviceId), "services", def.manifest.entry);

    // 3. Config directory presence (warn, not error, if empty/missing).
    const configDirPath = def.configDirPath;
    const configEntries = await fs.readdir(configDirPath).catch(() => null);
    if (configEntries === null) {
      logger().warn(COMPONENT, `start: config directory for "${serviceId}" does not exist`, { serviceId, configDirPath });
    } else if (configEntries.length === 0) {
      logger().warn(COMPONENT, `start: config directory for "${serviceId}" is empty`, { serviceId, configDirPath });
    }

    // Port conflict pre-check (FR-018/T033) — best effort, reading the
    // service's own <id>.json config file for a `port`/`host` field (the
    // same convention the worker itself reads, per the IPC protocol doc).
    // port: 0 means "OS assigns" — never pre-checked, always allowed.
    const configuredPort = await readConfiguredPort(configDirPath, serviceId);
    if (configuredPort && configuredPort.port !== 0) {
      const reservedReason = checkPortReservedByBos(configuredPort.port);
      if (reservedReason) {
        logger().error(COMPONENT, reservedReason, undefined, { serviceId, port: configuredPort.port });
        registry.setState(serviceId, "stopped", reservedReason);
        return;
      }
      const available = await checkPortAvailable(configuredPort.port, configuredPort.host);
      if (!available) {
        const message = `Port ${configuredPort.port} is already in use. Configure a different port in Settings, or set "port": 0 to let the OS assign one automatically.`;
        logger().error(COMPONENT, message, undefined, { serviceId, port: configuredPort.port });
        registry.setState(serviceId, "stopped", message);
        return;
      }
    }

    // 4. Create worker thread with resource limits.
    await fs.mkdir(path.dirname(def.logsPath), { recursive: true });
    let worker: Worker;
    try {
      // NOTE: Worker threads provide MEMORY isolation (separate V8 heaps, enforced by
      // resourceLimits), but NOT CPU isolation. A CPU-bound worker can starve the
      // main process. Resource limits (256MB old gen, 64MB young gen per worker)
      // prevent memory starvation. For CPU isolation, container-based services
      // would be needed (out of scope for v1).
      worker = createNodeWorker(Worker, entryPath, {
        workerData: { configDirPath, logsPath: def.logsPath, serviceId },
        resourceLimits: RESOURCE_LIMITS,
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      logger().error(COMPONENT, `start: failed to create worker for "${serviceId}"`, err, { serviceId, entryPath });
      registry.setState(serviceId, "stopped", `Failed to start worker: ${(err as Error).message}`);
      return;
    }

    registry.setWorker(serviceId, worker);
    this.wireWorkerEvents(serviceId, worker, def.logsPath);

    // 5/6. Send initialize, wait for initialized (CH-015 configurable timeout;
    // 0 means "proceed without waiting", not "wait forever").
    const startupTimeoutMs = Math.max(0, options.startupTimeout ?? DEFAULT_SERVICE_TIMEOUTS.startupTimeoutMs);
    postMessage(worker, { type: "initialize", configDirPath, logsPath: def.logsPath, serviceId });

    if (startupTimeoutMs > 0) {
      try {
        await waitForMessage(worker, "initialized", startupTimeoutMs);
      } catch (err) {
        logger().warn(COMPONENT, `start: "${serviceId}" did not initialize within ${startupTimeoutMs}ms — terminating`, {
          serviceId,
          error: (err as Error).message,
        });
        this.expectingExit.add(serviceId);
        await worker.terminate().catch(() => {});
        registry.setWorker(serviceId, null);
        registry.setState(serviceId, "stopped", `Did not report ready within ${startupTimeoutMs}ms — check its logs.`);
        return;
      }
    }

    // 7/8. Running; reset restart counter (successful init clears crash history).
    registry.resetRestart(serviceId);
    registry.setState(serviceId, "running");
    // 034-event-notification-system (FR-005b): catch up any already-registered
    // headless handlers of this service on events that went pending while it
    // was down — covers a restart where the service doesn't re-declare (the
    // handler_declare path above covers the case where it does).
    reevaluateAfterOwnerStarted(serviceId);
    logger().info(COMPONENT, `service "${serviceId}" started`, { serviceId, entryPath, port: configuredPort?.port });
  }

  private wireWorkerEvents(serviceId: string, worker: Worker, logsPath: string): void {
    const registry = serviceRegistry();

    worker.on("exit", (code) => {
      registry.setWorker(serviceId, null);
      if (this.expectingExit.has(serviceId)) {
        this.expectingExit.delete(serviceId);
        return;
      }
      // CH-001 — an unexpected exit (including a crash during `initialize`,
      // before any `initialized`/`crash` message could be sent) is a crash.
      this.cleanupServiceTools(serviceId);
      // 034-event-notification-system (FR-019/edge cases): this service's
      // headless handlers just stopped being "active" — re-evaluate every
      // pending event so any that were only waiting on them can complete.
      reevaluateAllPending();
      void handleCrash(serviceId, `Worker exited unexpectedly with code ${code}`);
    });

    worker.on("error", (err) => {
      if (this.expectingExit.has(serviceId)) return;
      void handleCrash(serviceId, err.message, err.stack);
    });

    worker.on("message", (msg: WorkerToMainMessage) => {
      void this.handleWorkerMessage(serviceId, msg, logsPath);
    });

    worker.stdout?.on("data", (chunk: Buffer) => void appendServiceLog(logsPath, chunk.toString("utf8")));
    worker.stderr?.on("data", (chunk: Buffer) => void appendServiceLog(logsPath, chunk.toString("utf8")));
  }

  private async handleWorkerMessage(serviceId: string, msg: WorkerToMainMessage, logsPath: string): Promise<void> {
    const registry = serviceRegistry();
    switch (msg.type) {
      case "bound": {
        const def = registry.getService(serviceId);
        if (def) await writeRuntimeState(def.configDirPath, msg.port, msg.host);
        registry.setBound(serviceId, msg.port, msg.host);
        break;
      }
      case "log": {
        await appendServiceLog(logsPath, `[${msg.level}] ${msg.message}`);
        break;
      }
      case "crash": {
        void handleCrash(serviceId, msg.error, msg.stack);
        break;
      }
      case "error": {
        logger().error(COMPONENT, `service "${serviceId}" reported an error`, undefined, {
          serviceId,
          message: msg.message,
          stack: msg.stack,
        });
        await appendServiceLog(logsPath, `[error] ${msg.message}`);
        break;
      }
      case "tool_declare": {
        const { declaration, callId } = msg.payload;
        logger().info(TOOL_LOG, "tool_declare:received", { serviceId, name: declaration.name, callId });
        const def = registry.getService(serviceId);
        if (def?.manifest.deploymentMode !== "tools") {
          logger().warn(TOOL_LOG, "tool_declare:rejected", {
            serviceId,
            name: declaration.name,
            callId,
            reason: `deploymentMode is "${def?.manifest.deploymentMode ?? "default"}", not "tools"`,
          });
          break;
        }
        serviceToolBridge().registerTool(serviceId, declaration);
        break;
      }
      case "tool_result":
      case "tool_error":
        // Resolved by workerIpc's waitForToolResult, which attaches its own
        // callId-keyed listener directly to the worker (same pattern as
        // "initialized"/"disposed" alongside waitForMessage) — nothing to do here.
        break;
      case "handler_declare": {
        // 034-event-notification-system (ADR-3, T029): a service declares a
        // headless handler at startup. Re-declaring the same handlerId is an
        // idempotent upsert (register() preserves a previously-set `enabled`).
        const { handlerId, eventType, displayName, description, icon, timeoutMs, callId } = msg.payload;
        logger().info(EVENTS_LOG, "handler_declare:received", { serviceId, handlerId, eventType, callId });
        try {
          await eventsApi.register({
            handlerId,
            eventType,
            mode: "headless",
            ownerId: serviceId,
            displayName,
            description,
            icon,
            timeoutMs,
            declaredBy: "service",
            grantedNamespaces: registry.getService(serviceId)?.manifest.eventNamespaces,
          });
          logger().info(EVENTS_LOG, "handler_declare:registered", { serviceId, handlerId, callId });
        } catch (err) {
          logger().warn(EVENTS_LOG, "handler_declare:rejected", {
            serviceId,
            handlerId,
            callId,
            error: (err as Error).message,
          });
        }
        // The service is already "running" by the time it can send this
        // message, but a handler that was previously registered while the
        // service was down (or disabled) may now have pending work to catch
        // up on — register() already does this for a brand-new/changed
        // registration; this covers the "nothing about the registration
        // changed, the service just (re)started" case.
        reevaluateAfterOwnerStarted(serviceId);
        break;
      }
      case "initialized":
      case "disposed":
        break;
      default:
        break;
    }
  }

  /** Stop lifecycle operation (spec "Lifecycle operations" §2). */
  async stop(serviceId: string, options: StopOptions = {}): Promise<void> {
    const registry = serviceRegistry();
    const def = registry.getService(serviceId);
    if (!def) return;

    cancelPendingRestart(serviceId);

    const worker = def.worker;
    if (!worker) {
      registry.setState(serviceId, "stopped");
      registry.resetRestart(serviceId);
      this.cleanupServiceTools(serviceId);
      reevaluateAllPending();
      return;
    }

    this.expectingExit.add(serviceId);
    const shutdownTimeoutMs = Math.max(0, options.shutdownTimeout ?? DEFAULT_SERVICE_TIMEOUTS.shutdownTimeoutMs);
    postMessage(worker, { type: "dispose" });

    if (shutdownTimeoutMs > 0) {
      try {
        await waitForMessage(worker, "disposed", shutdownTimeoutMs);
      } catch (err) {
        logger().warn(COMPONENT, `stop: "${serviceId}" did not dispose within ${shutdownTimeoutMs}ms — terminating`, {
          serviceId,
          error: (err as Error).message,
        });
      }
    }

    await worker.terminate().catch(() => {});
    registry.setWorker(serviceId, null);
    registry.setState(serviceId, "stopped");
    registry.resetRestart(serviceId);
    this.cleanupServiceTools(serviceId);
    reevaluateAllPending();
    logger().info(COMPONENT, `service "${serviceId}" stopped`, { serviceId });
  }

  /** Restart lifecycle operation — Stop then Start; state briefly shows "restarting". */
  async restart(serviceId: string, reason?: string): Promise<void> {
    const registry = serviceRegistry();
    if (!registry.getService(serviceId)) return;
    logger().info(COMPONENT, `service "${serviceId}" restarting`, { serviceId, reason });
    registry.setState(serviceId, "restarting");
    await this.stop(serviceId);
    await this.start(serviceId);
  }

  /**
   * Start every installed service in dependency order (T032), skipping any
   * dependent service whose dependencies aren't running yet (CH-003/T030).
   * Never throws — a single service's failure is logged and startup moves on
   * to the next one (CH-007), so boot always completes regardless.
   *
   * Runs up to MAX_BOOT_START_ATTEMPTS passes over the ordered list (CH-013):
   * a service skipped because a dependency wasn't running yet gets another
   * chance once that dependency starts on a later pass. Each service's own
   * start attempts are capped independently — after MAX_BOOT_START_ATTEMPTS
   * failures it is given up on and excluded from further passes. This applies
   * ONLY to this boot-time call; manual start()/restart() always retry.
   */
  async startAll(): Promise<void> {
    const registry = serviceRegistry();
    const installed = registry.getAllServices().filter((d) => d.installed && d.state !== "corrupted");
    const ordered = resolveOrder(installed.map((d) => d.manifest));
    const pending = new Set(ordered.map((m) => m.id));

    this.bootAttempts.clear();
    for (let pass = 0; pass < MAX_BOOT_START_ATTEMPTS && pending.size > 0; pass++) {
      for (const manifest of ordered) {
        if (!pending.has(manifest.id)) continue;
        if (registry.getService(manifest.id)?.state === "running") {
          pending.delete(manifest.id);
          continue;
        }

        if (!checkDependenciesRunning(manifest.id, registry)) {
          const missing = (manifest.dependencies ?? []).filter((dep) => registry.getService(dep)?.state !== "running");
          logger().warn(
            COMPONENT,
            `Dependency ${missing.join(", ")} not running — skipping service "${manifest.id}" to avoid crash loop`,
            { serviceId: manifest.id, missing },
          );
          continue;
        }

        const attempts = (this.bootAttempts.get(manifest.id) ?? 0) + 1;
        this.bootAttempts.set(manifest.id, attempts);
        try {
          await this.start(manifest.id);
        } catch (err) {
          logger().warn(COMPONENT, `startAll: service "${manifest.id}" failed to start (attempt ${attempts}/${MAX_BOOT_START_ATTEMPTS})`, {
            serviceId: manifest.id,
            error: (err as Error).message,
          });
        }

        if (registry.getService(manifest.id)?.state === "running") {
          pending.delete(manifest.id);
        } else if (attempts >= MAX_BOOT_START_ATTEMPTS) {
          logger().warn(COMPONENT, `startAll: giving up on service "${manifest.id}" after ${attempts} failed start attempts`, {
            serviceId: manifest.id,
          });
          pending.delete(manifest.id);
        }
      }
    }
    this.bootAttempts.clear();
  }
}

// Hot-reload-safe singleton (same pattern as RunManager / ServiceRegistry).
const g = globalThis as unknown as { __bosServiceManager?: ServiceManager };

export function serviceManager(): ServiceManager {
  if (!g.__bosServiceManager) {
    g.__bosServiceManager = new ServiceManager();
  }
  return g.__bosServiceManager;
}
