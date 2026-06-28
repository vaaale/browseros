// Parse the `args` a model passes to callMcpServerTool (014-mcp-tool-gateway).
//
// The arguments MUST travel as a JSON STRING, not an object parameter: CopilotKit
// converts an `object`-typed action parameter that has no declared sub-properties
// into a closed JSON schema ({ type: "object" } with no properties /
// additionalProperties), so the model's keys get stripped to `{}` before the call
// is made. A string passes through untouched; we parse it here. Pure (no deps) so
// it's unit-testable and usable from the client action handler.
export function parseToolArgs(raw: unknown): { args?: Record<string, unknown>; error?: string } {
  if (raw == null || raw === "") return { args: {} };
  // Defensive: if some path already handed us an object, use it as-is.
  if (typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (typeof raw !== "string") return { error: `args must be a JSON object string; got ${typeof raw}.` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: `args is not valid JSON: ${raw}` };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return { args: value as Record<string, unknown> };
  return { error: `args must be a JSON object, got: ${raw}` };
}
