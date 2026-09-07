import "server-only";
import Ajv, { type ValidateFunction } from "ajv";
import { logger } from "@/lib/logging";
import { LOG, type ToolDeclaration } from "@/core/service/serviceToolTypes";
import type { ServiceTool, ToolInvocation, ToolInvocationResult } from "@/core/service/serviceToolTypes";
import type { ToolCallFailureCode } from "@/core/service/workerIpc";
import { registerAdditionalCapabilities, unregisterCapabilities } from "@/lib/agent/capabilities-registry";
import { registerToolGroups, unregisterToolGroups } from "@/lib/agent/tool-groups";
import type { ToolGroupDeclaration } from "@/core/service/serviceToolTypes";

// ServiceToolBridge (039-service-tool-exposure) — the single facade that turns
// a service's `tool_declare` messages into registered `ServiceTool` entries,
// keyed `serviceId:name`. Hot-reload-safe singleton, mirroring serviceRegistry()/
// serviceManager() (src/core/service/ServiceRegistry.ts, ServiceManager.ts).
//
// Registration validates each declaration's `inputSchema` with Ajv (compiled
// once, reused on every invocation) and rejects a duplicate `serviceId:name`
// (R3). `invoke()` re-validates args before dispatch (FR-004) and, on a valid
// call, hands off to a dispatcher registered by ServiceManager (which owns the
// live `Worker` reference) — this indirection keeps the bridge free of any
// import on ServiceManager.ts, avoiding a module cycle (ServiceManager already
// imports THIS module to register/unregister tools on lifecycle transitions).

/** Registered by ServiceManager at module load: given a serviceId + a
 *  ToolInvocation, dispatch it (worker IPC) and resolve/reject with the
 *  worker's tool_result/tool_error. The bridge never talks to a Worker
 *  directly — see module comment above. `signal` (039-service-tool-exposure
 *  T033, R10) is the calling run's per-call abort signal — a dispatcher that
 *  forwards it to `waitForToolResult` lets a run-abort or the loop's own
 *  idle-timeout cancel the pending waiter instead of leaking it. */
export type ToolDispatcher = (
  serviceId: string,
  invocation: ToolInvocation,
  signal?: AbortSignal,
) => Promise<ToolInvocationResult>;

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

function toolKey(serviceId: string, name: string): string {
  return `${serviceId}:${name}`;
}

let callCounter = 0;
function nextCallId(): string {
  callCounter += 1;
  return `tool-call-${Date.now()}-${callCounter}`;
}

export class ServiceToolBridge {
  private tools = new Map<string, ServiceTool>();
  private validators = new Map<string, ValidateFunction>();
  private ajv = new Ajv({ strict: false });
  private dispatcher: ToolDispatcher | null = null;
  private toolCallTimeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS;

  /** Bumped on every successful register/unregister so consumers (registry.ts's
   *  assistantTools() cache) can detect staleness without the bridge having to
   *  import back into src/lib/assistant. */
  private _version = 0;

  get version(): number {
    return this._version;
  }

  /** Read-only view of every currently-registered service tool. */
  get registry(): ReadonlyMap<string, ServiceTool> {
    return this.tools;
  }

  /** ServiceManager wires this once at module load — see the bottom of
   *  ServiceManager.ts. Tests may set their own stub dispatcher directly. */
  setDispatcher(dispatcher: ToolDispatcher | null): void {
    this.dispatcher = dispatcher;
  }

  setToolCallTimeoutMs(timeoutMs: number): void {
    this.toolCallTimeoutMs = timeoutMs;
  }

  /** Validates the declaration (name shape, description, `inputSchema` is a
   *  compilable JSON Schema, and a RESOLVABLE tool group) and rejects an exact
   *  `serviceId:name` duplicate. Returns whether registration succeeded.
   *
   *  `toolGroups` is the owning service's manifest declaration (041 ADR-5).
   *  A tool that does not resolve to one of them is REJECTED — it is never
   *  filed under a generic bucket, because there is no fallback group
   *  (FR-041). Callers must surface the failure to the user (ServiceManager
   *  sets the service's `lastError`), not merely log it. */
  registerTool(serviceId: string, declaration: ToolDeclaration, toolGroups: ToolGroupDeclaration[] = []): boolean {
    const name = declaration?.name;
    if (typeof name !== "string" || !name.trim()) {
      logger().warn(LOG, "tool:register-rejected", { serviceId, reason: "missing-name" });
      return false;
    }
    if (typeof declaration.description !== "string" || !declaration.description.trim()) {
      logger().warn(LOG, "tool:register-rejected", { serviceId, name, reason: "missing-description" });
      return false;
    }

    const key = toolKey(serviceId, name);
    if (this.tools.has(key)) {
      logger().warn(LOG, "tool:register-rejected", { serviceId, name, reason: "duplicate" });
      return false;
    }

    // 041-tool-groups: resolve the declaration's group against the manifest.
    // One declared group is implied; several and the tool must pick, because
    // guessing would silently file it under the wrong heading.
    let group: ToolGroupDeclaration | undefined;
    if (toolGroups.length === 0) {
      logger().warn(LOG, "tool:register-rejected", { serviceId, name, reason: "no-tool-groups-declared" });
      return false;
    }
    if (declaration.group) {
      group = toolGroups.find((g) => g.id === declaration.group);
      if (!group) {
        logger().warn(LOG, "tool:register-rejected", {
          serviceId,
          name,
          reason: "unknown-group",
          group: declaration.group,
          declared: toolGroups.map((g) => g.id),
        });
        return false;
      }
    } else if (toolGroups.length === 1) {
      group = toolGroups[0];
    } else {
      logger().warn(LOG, "tool:register-rejected", {
        serviceId,
        name,
        reason: "ambiguous-group",
        declared: toolGroups.map((g) => g.id),
      });
      return false;
    }

    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(declaration.inputSchema ?? {});
    } catch (err) {
      logger().warn(LOG, "tool:register-rejected", {
        serviceId,
        name,
        reason: "invalid-schema",
        error: (err as Error).message,
      });
      return false;
    }

    this.tools.set(key, { declaration, serviceId, transport: "worker-ipc", groupId: group.id });
    this.validators.set(key, validate);
    this._version += 1;
    // FR-005/ADR-007: register a capability descriptor under the SAME id as the
    // tool's AssistantTool name (not a namespaced id) — gate.ts/tool-gate.ts
    // build their `registryIds` from listCapabilities().map(c => c.id) and
    // gate by comparing against the model-facing tool name, so the two must
    // match exactly or a live service tool would fall into tool-gate.ts's
    // "not in registry ⇒ always allowed" branch and bypass gating entirely.
    registerToolGroups([
      { id: group.id, name: group.name, description: group.description, aliases: group.aliases ?? [], origin: "service" },
    ]);
    registerAdditionalCapabilities([
      { id: name, group: group.id, context: "tool", description: declaration.description },
    ]);
    logger().info(LOG, "tool:registered", { serviceId, name });
    return true;
  }

  /** Removes the capability descriptor for `name` unless another still-registered
   *  service tool of the same name needs it to stay gated (two services may
   *  declare a same-named tool independently — R3). */
  private syncCapabilityAfterRemoval(name: string): void {
    const stillNeeded = [...this.tools.values()].some((t) => t.declaration.name === name);
    if (!stillNeeded) unregisterCapabilities([name]);
  }

  /** Drops a group once its last member tool is gone (041 FR-004), mirroring
   *  syncCapabilityAfterRemoval. The user's persisted override for that group
   *  is deliberately NOT touched — an absent group is not a deleted one
   *  (FR-049). */
  private syncGroupsAfterRemoval(groupIds: string[]): void {
    const live = new Set([...this.tools.values()].map((t) => t.groupId));
    const orphaned = [...new Set(groupIds)].filter((id) => !live.has(id));
    if (orphaned.length > 0) unregisterToolGroups(orphaned);
  }

  unregisterTool(serviceId: string, name: string): void {
    const key = toolKey(serviceId, name);
    const removed = this.tools.get(key);
    if (!this.tools.delete(key)) return;
    this.validators.delete(key);
    this._version += 1;
    this.syncCapabilityAfterRemoval(name);
    if (removed) this.syncGroupsAfterRemoval([removed.groupId]);
    logger().info(LOG, "tool:unregistered", { serviceId, name });
  }

  unregisterServiceTools(serviceId: string): void {
    const owned = [...this.tools.values()].filter((t) => t.serviceId === serviceId);
    if (owned.length === 0) return;
    for (const tool of owned) {
      const key = toolKey(serviceId, tool.declaration.name);
      this.tools.delete(key);
      this.validators.delete(key);
      logger().info(LOG, "tool:unregistered", { serviceId, name: tool.declaration.name });
    }
    for (const tool of owned) this.syncCapabilityAfterRemoval(tool.declaration.name);
    this.syncGroupsAfterRemoval(owned.map((t) => t.groupId));
    this._version += 1;
  }

  /** Every tool currently registered for one service — lifecycle bookkeeping. */
  serviceToolsFor(serviceId: string): ServiceTool[] {
    return [...this.tools.values()].filter((t) => t.serviceId === serviceId);
  }

  /** Validates `args` against the tool's declared `inputSchema` (FR-004) and,
   *  only if valid, dispatches through the registered `ToolDispatcher`.
   *  Throws (never dispatches) on: unknown tool, schema-validation failure, or
   *  no dispatcher wired up — the agent loop's `runServerTool` already turns a
   *  thrown error into an in-band `Error: <tool>: …` string for the model.
   *  `signal` (039-service-tool-exposure T033) is `runServerTool`'s per-call
   *  abort signal — forwarded to the dispatcher so a run-abort or the loop's
   *  own idle-timeout cancels the pending IPC waiter instead of leaking it. */
  async invoke(serviceId: string, name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const key = toolKey(serviceId, name);
    const tool = this.tools.get(key);
    const validate = this.validators.get(key);
    if (!tool || !validate) {
      throw new Error(`unknown tool "${name}" for service "${serviceId}"`);
    }

    if (!validate(args)) {
      const detail = this.ajv.errorsText(validate.errors ?? [], { separator: "; " });
      logger().warn(LOG, "tool_call:schema-rejected", { serviceId, name, error: detail });
      throw new Error(detail);
    }

    if (!this.dispatcher) {
      throw new Error(`service "${serviceId}" tool dispatch is not wired up — this is a BOS bug`);
    }

    const callId = nextCallId();
    const start = Date.now();
    logger().info(LOG, "tool_call:dispatch", { serviceId, name, callId });

    let outcome: ToolInvocationResult;
    try {
      outcome = await this.dispatcher(serviceId, { callId, name, args }, signal);
    } catch (err) {
      const durationMs = Date.now() - start;
      const code = (err as { code?: ToolCallFailureCode }).code;
      const message = (err as Error).message;
      // T035 — distinct warn/error records per failure kind, on top of the
      // catch-all `tool_call:resolved` (ok:false) below.
      if (code === "timeout") {
        logger().warn(LOG, "tool_call:timeout", { serviceId, name, callId });
      } else if (code === "cancelled") {
        logger().warn(LOG, "tool_call:cancelled", { serviceId, name, callId });
      } else {
        logger().error(LOG, "tool_call:error", undefined, { serviceId, name, callId, error: message });
      }
      logger().warn(LOG, "tool_call:resolved", { serviceId, name, callId, durationMs, ok: false, error: message });
      throw err;
    }

    const durationMs = Date.now() - start;
    if (outcome.error) {
      // A `tool_error` the worker itself reported (FR-007) — the service ran
      // and failed, as opposed to the IPC round-trip itself failing above.
      logger().error(LOG, "tool_call:error", undefined, { serviceId, name, callId, error: outcome.error.message });
      logger().warn(LOG, "tool_call:resolved", {
        serviceId,
        name,
        callId,
        durationMs,
        ok: false,
        error: outcome.error.message,
      });
      throw new Error(outcome.error.message);
    }

    logger().info(LOG, "tool_call:resolved", { serviceId, name, callId, durationMs, ok: true });
    return typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result ?? "");
  }

  getToolCallTimeoutMs(): number {
    return this.toolCallTimeoutMs;
  }
}

// Hot-reload-safe singleton (same pattern as serviceManager()/serviceRegistry()).
const g = globalThis as unknown as { __bosServiceToolBridge?: ServiceToolBridge };

export function serviceToolBridge(): ServiceToolBridge {
  if (!g.__bosServiceToolBridge) {
    g.__bosServiceToolBridge = new ServiceToolBridge();
  }
  return g.__bosServiceToolBridge;
}
