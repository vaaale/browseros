import "server-only";
import { getConversationMeta, patchConversationMeta } from "@/lib/assistant/conversation-store";

// The re-entrancy guard (031-self-healing FR-025, design ADR-4).
//
// FR-025 is satisfied primarily BY CONSTRUCTION, and this module is the backstop
// for the two paths where construction isn't enough:
//
//  1. Headless self-heal runs never fire a plugin hook. `runLocalHeadless`
//     (src/lib/agent/subagents/runner.ts) calls `runAgentLoop` WITHOUT a `hooks`
//     argument — `composePluginHooks` is wired only into the main chat run
//     (src/lib/assistant/start-run.ts). So a failing Diagnostician, or a tool
//     error inside the BS pipeline it spawned, cannot reach the trigger-capture
//     hook at all. Verified against those files; if that ever changes, guard (b)
//     below still holds.
//
//  2. A self-heal conversation CAN later be driven from the main chat UI (the
//     user opens the pipeline conversation and types). That run does fire the
//     hook, and the hook's only usable identity is `ctx.conversationId` — the
//     HookContext is `{runId, conversationId, agentId}` and has no role field.
//     Hence (a): a marker written onto the conversation record.
//
//  (a) CONVERSATION MARKER — every conversation the spine seeds carries
//      `selfHeal: {role, caseId}`. The hook skips any conversation that has it.
//  (b) EVENT-PAYLOAD FILTER — every event-shaped trigger is filtered in the
//      spine's own front door: an event whose payload carries `selfHeal.role` is
//      never intake'd. This one is hook-independent, so it holds regardless of
//      which run path produced the event.

export type SelfHealRole = "diagnostician" | "pipeline" | "lifecycle";

export interface SelfHealConversationMarker {
  role: SelfHealRole;
  caseId: string;
}

/** Stamp a spine-seeded conversation so the trigger hook can recognize it. */
export async function markSelfHealConversation(
  conversationId: string,
  marker: SelfHealConversationMarker,
): Promise<void> {
  if (!conversationId) return;
  await patchConversationMeta(conversationId, { selfHeal: marker });
}

/** Read the marker, if any. */
export async function getSelfHealConversationMarker(
  conversationId: string,
): Promise<SelfHealConversationMarker | undefined> {
  if (!conversationId) return undefined;
  const meta = await getConversationMeta(conversationId);
  const marker = meta?.selfHeal;
  if (!marker || typeof marker !== "object") return undefined;
  const { role, caseId } = marker as Partial<SelfHealConversationMarker>;
  if (role !== "diagnostician" && role !== "pipeline" && role !== "lifecycle") return undefined;
  return { role, caseId: typeof caseId === "string" ? caseId : "" };
}

/** Guard (a): is this conversation one the spine created? Never throws — the
 *  caller is a hook, and a hook that throws must not affect the run. */
export async function isSelfHealConversation(conversationId: string): Promise<boolean> {
  try {
    return (await getSelfHealConversationMarker(conversationId)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Guard (b): does this event payload come from a self-heal run?
 *
 * Pure and synchronous — it runs inside the deterministic intake front door
 * (intake.ts) on EVERY event-shaped trigger, so recursion stays bounded even if
 * a future change wires hooks into headless runs.
 */
export function isSelfHealOriginPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const marker = (payload as Record<string, unknown>).selfHeal;
  if (!marker || typeof marker !== "object") return false;
  return typeof (marker as Record<string, unknown>).role === "string";
}

/** Drop every self-heal-origin event from a batch (the scheduled Mode-2 pass
 *  reads the pending event queue and must not re-ingest its own history). */
export function filterSelfHealEvents<T extends { payload?: unknown }>(events: T[]): T[] {
  return events.filter((e) => !isSelfHealOriginPayload(e.payload));
}
