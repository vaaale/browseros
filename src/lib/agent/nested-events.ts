// Encodes a delegated sub-agent's events into the delegation tool result so the
// chat can render them nested under the delegation card. Marker-based so the
// human-readable summary (which the LLM reads) comes first.
//
// 045-chat-live-tool (ADR-3 / B1): the payload is a payload-SHAPE change, not a
// new event type. Each `NestedEvent` now carries its own settled `result?` /
// `status?` and its own `nested?` child list (recursion by structure), so a done
// delegation's child-card tree rebuilds from the persisted string ALONE after a
// reload (when the live progress[] is empty). The NESTED_MARKER and the
// encodeNested/parseNested entry points are unchanged; parseNested tolerates both
// the widened shape and legacy `{ tool, input }`-only payloads.

export const NESTED_MARKER = "BOS-NESTED";

export type NestedEventStatus = "running" | "done" | "cancelled";

export interface NestedEvent {
  tool: string;
  input?: unknown;
  /** The child's settled result string (present once it completed). Absent for
   *  starts-only payloads (e.g. the claude harness) and for running children. */
  result?: string;
  /** The child's terminal status. Absent on legacy starts-only entries. */
  status?: NestedEventStatus;
  /** The child's own nested child list — a child that is itself a delegation
   *  reuses its own encodeNested result here, so the tree recurses by structure. */
  nested?: NestedEvent[];
}

export interface NestedPayload {
  events: NestedEvent[];
  output: string;
}

export function encodeNested(payload: NestedPayload): string {
  return NESTED_MARKER + JSON.stringify(payload);
}

export function parseNested(value: string): NestedPayload | null {
  if (typeof value !== "string") return null;
  const i = value.indexOf(NESTED_MARKER);
  if (i === -1) return null;
  try {
    const p = JSON.parse(value.slice(i + NESTED_MARKER.length)) as NestedPayload;
    return Array.isArray(p.events) ? p : null;
  } catch {
    return null;
  }
}

// The LIVE in-flight projection of a delegation's nested work, streamed through
// the per-call tool_progress channel (ToolContext.onEvent → progress[]). It is a
// discriminated union so the card can fold it into child cards while the
// delegation is still running (FR-006/FR-016). A START is the legacy shape
// ({ tool, input } — no `type`), preserved so existing runs and the starts-only
// claude path still render; RESULT and CANCEL are discriminated by `type`.
// `callId` is the INNER call's id (when known) so the card can match a result to
// its start exactly rather than by tool name alone.
export type NestedProgressEntry =
  | { tool: string; input?: unknown; callId?: string }
  | { tool: string; type: "tool_result"; callId?: string; result: string }
  | { tool: string; type: "tool_cancelled"; callId?: string };
