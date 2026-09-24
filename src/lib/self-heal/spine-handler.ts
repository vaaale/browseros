import "server-only";
import { logger } from "@/lib/logging";
import * as eventsApi from "@/lib/events/api";
import { registerCoreExecutor } from "@/lib/events/dispatch";
import type { EventRecord } from "@/lib/events/types";
import { selfHealIntake, resumeCase } from "./intake";
import { isBosOwnedLogComponent } from "./allowlist";
import { SELF_HEAL_LOG } from "./events";
import { SELF_HEAL_EVENTS, SELF_HEAL_EVENT_NAMESPACE, type TriggerContext } from "./types";

// The 034 core headless handler that fronts the spine (031-self-healing,
// design ADR-1).
//
// The spine reacts to EVENTS, which is precisely why it can be neither a
// scheduler job (time-based only) nor a 002 workflow service (no
// deterministic-code node, no event-triggered runs, no cross-run in-process
// slot, no in-run suspend/resume). A 034 core executor gives all four using
// machinery BOS already has.
//
// One handler covers the whole `com.bos.self-heal.*` namespace and dispatches on
// the event type. It returns as soon as the deterministic front door has
// decided: the Diagnostician and the BS pipeline are launched fire-and-forget by
// `intake.ts`, so the executor's ack window (default 30s) is never at risk (R4).

export const SELF_HEAL_HANDLER_ID = "core:self-heal";

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function numOf(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map a trigger event's payload onto a TriggerContext.
 *
 * Deliberately tolerant of shape: the workflow-timeout trigger (FR-004) rides
 * an event the 002 Workflow Manager service emits, which does not exist yet
 * (design R7 — a cross-spec dependency). Reading only the three fields FR-004
 * names means the trigger works the moment 002 starts emitting, and stays inert
 * (it is off by default) until then, rather than failing on an unexpected body.
 */
export function triggerContextFromEvent(record: EventRecord): TriggerContext | undefined {
  const p = record.payload ?? {};
  const declared = str(p, "trigger");

  if (declared === "workflow-timeout" || p.workflowId !== undefined || p.workflow !== undefined) {
    const workflowSource = (p.workflow && typeof p.workflow === "object" ? (p.workflow as Record<string, unknown>) : p) as Record<string, unknown>;
    const id = str(workflowSource, "id") ?? str(p, "workflowId");
    if (!id) return undefined;
    return {
      trigger: "workflow-timeout",
      toolName: `workflow:${id}`,
      errorMessage: str(p, "errorMessage") ?? `workflow ${id} exceeded its configured timeout`,
      errorCode: "TimeoutError",
      workflow: {
        id,
        ...(str(workflowSource, "node") ?? str(p, "node") ? { node: str(workflowSource, "node") ?? str(p, "node") } : {}),
        ...(numOf(workflowSource, "configuredMs") !== undefined ? { configuredMs: numOf(workflowSource, "configuredMs") } : {}),
        ...(numOf(workflowSource, "actualMs") !== undefined ? { actualMs: numOf(workflowSource, "actualMs") } : {}),
      },
      eventId: record.id,
      extra: p,
    };
  }

  if (declared === "log-events" || (p.component !== undefined && (p.level === "error" || declared === undefined))) {
    const component = str(p, "component");
    if (!component) return undefined;
    return {
      trigger: "log-events",
      component,
      toolName: component,
      errorMessage: str(p, "message") ?? str(p, "errorMessage") ?? "error-level log event",
      ...(str(p, "code") ? { errorCode: str(p, "code") } : {}),
      eventId: record.id,
      extra: p,
    };
  }

  const trigger =
    declared === "explicit" || declared === "hard-error" || declared === "repeated-failure" ? declared : "explicit";
  return {
    trigger,
    ...(str(p, "description") ? { description: str(p, "description") } : {}),
    ...(str(p, "toolName") ? { toolName: str(p, "toolName") } : {}),
    ...(str(p, "errorMessage") ? { errorMessage: str(p, "errorMessage") } : {}),
    ...(str(p, "errorCode") ? { errorCode: str(p, "errorCode") } : {}),
    ...(numOf(p, "httpStatus") !== undefined ? { httpStatus: numOf(p, "httpStatus") } : {}),
    ...(str(p, "conversationId") ? { conversationId: str(p, "conversationId") } : {}),
    ...(str(p, "filePath") ? { filePath: str(p, "filePath") } : {}),
    ...(str(p, "appId") ? { appId: str(p, "appId") } : {}),
    eventId: record.id,
    extra: p,
  };
}

async function handleEvent(record: EventRecord): Promise<{ result?: unknown }> {
  const type = record.type;

  if (type === SELF_HEAL_EVENTS.decisionResolved) {
    const caseId = str(record.payload ?? {}, "caseId");
    const answer = str(record.payload ?? {}, "answer");
    if (!caseId || !answer) return { result: { ignored: "decision_resolved needs caseId and answer" } };
    const resumed = await resumeCase(caseId, answer);
    return { result: { resumed: resumed?.id ?? null, status: resumed?.status ?? null } };
  }

  if (type === SELF_HEAL_EVENTS.trigger) {
    const ctx = triggerContextFromEvent(record);
    if (!ctx) return { result: { ignored: "the trigger payload named no recognizable failure" } };
    if (ctx.trigger === "log-events" && !isBosOwnedLogComponent(ctx.component)) {
      return { result: { ignored: `component "${ctx.component ?? ""}" is not BOS-owned` } };
    }
    const outcome = await selfHealIntake(ctx, { eventPayload: record.payload });
    return { result: outcome };
  }

  // Every other `com.bos.self-heal.*` event is one the spine itself emitted —
  // the lifecycle/audit channel. Acknowledged and ignored: acting on our own
  // notifications is the recursion FR-025 forbids.
  return { result: { ignored: `no spine action for ${type}` } };
}

let registered = false;

/**
 * Register the spine's core handler for the whole `com.bos.self-heal.*`
 * namespace. Idempotent — safe to call from boot and from a route that may
 * import this module first.
 */
export async function registerSelfHealSpine(): Promise<void> {
  registerCoreExecutor(SELF_HEAL_HANDLER_ID, async (record) => {
    try {
      return await handleEvent(record);
    } catch (err) {
      // A throwing handler is retried by the kernel with backoff. Intake is
      // idempotent (keyed read-modify-write on the case store), so a retry is
      // safe — but the reason still has to be visible.
      logger().error(SELF_HEAL_LOG, "spine handler failed", undefined, {
        eventType: record.type,
        error: (err as Error).message,
      });
      throw err;
    }
  });

  if (registered) return;
  registered = true;
  await eventsApi.register({
    handlerId: SELF_HEAL_HANDLER_ID,
    eventType: SELF_HEAL_EVENT_NAMESPACE,
    mode: "headless",
    ownerId: "core",
    declaredBy: "core",
    displayName: "Self-Healing spine",
    description:
      "Deterministic coordinator for the self-healing mechanism: dedupes triggers, enforces the cost cap, creates Healing Cases, runs the Diagnostician, and routes by scope class.",
    icon: "HeartPulse",
  });
  logger().info(SELF_HEAL_LOG, "spine handler registered", { eventType: SELF_HEAL_EVENT_NAMESPACE });
}

/** Test seam: allow re-registration after a kernel reset. */
export function _resetSpineRegistrationForTests(): void {
  registered = false;
}
