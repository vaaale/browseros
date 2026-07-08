// Encodes a delegated sub-agent's events into the delegation tool result so the
// chat can render them nested under the delegation card. Marker-based so the
// human-readable summary (which the LLM reads) comes first.

export const NESTED_MARKER = "BOS-NESTED";

export interface NestedEvent {
  tool: string;
  input?: unknown;
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
