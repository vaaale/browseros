import "server-only";
import * as eventsApi from "@/lib/events/api";
import { logger } from "@/lib/logging";
import { SELF_HEAL_EVENTS, SELF_HEAL_EVENT_SOURCE, humanCaseId, type HealingCase } from "./types";

// Lifecycle-event emission (031-self-healing FR-026).
//
// 034 events are the audit + notification channel; the case store is the state
// (design ADR-6). The ordering rule is EMIT-AFTER-COMMIT: the spine writes the
// case first, then emits — so a reader that reacts to the event always finds
// the store already consistent.
//
// Emission is best-effort by design. A failure to notify must never roll back a
// state transition that already happened (the transition is the truth, the event
// is the announcement), so every emit is caught and logged.

export const SELF_HEAL_LOG = "self-heal";

type SelfHealEventType = (typeof SELF_HEAL_EVENTS)[keyof typeof SELF_HEAL_EVENTS];

export async function emitSelfHeal(
  type: SelfHealEventType,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    const result = await eventsApi.emit({ type, payload, source: SELF_HEAL_EVENT_SOURCE });
    return result.id;
  } catch (err) {
    logger().warn(SELF_HEAL_LOG, `emitting ${type} failed`, { error: (err as Error)?.message ?? String(err) });
    return undefined;
  }
}

/** The payload fields every case-scoped event carries, so the Event Viewer and
 *  the BS pane can render a row without a store read. `selfHeal.role` is also
 *  the re-entrancy marker the intake filter looks for (design ADR-4). */
export function casePayload(record: HealingCase, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    caseId: record.id,
    humanId: humanCaseId(record.id),
    trigger: record.trigger,
    status: record.status,
    title: record.title,
    dedupeKey: record.signature.dedupeKey,
    ...(record.scopeClass ? { scopeClass: record.scopeClass } : {}),
    ...(record.ownership ? { ownership: record.ownership } : {}),
    ...(record.proposedSurface ? { proposedSurface: record.proposedSurface } : {}),
    ...(record.reportPath ? { reportPath: record.reportPath } : {}),
    selfHeal: { role: "lifecycle", caseId: record.id },
    ...extra,
  };
}

export function summaryFor(record: HealingCase, verb: string): string {
  return `${humanCaseId(record.id)} ${verb} — ${record.title}`;
}
