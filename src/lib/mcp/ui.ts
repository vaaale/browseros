// MCP Apps / MCP-UI: MCP tools may return interactive HTML resources. The MCP
// client encodes such resources with a marker so the chat renderer can show
// them in a sandboxed iframe. Shared by server (client.ts) and client (renderer).

export const MCPUI_MARKER = "MCP-UI";

export interface McpUiPayload {
  html?: string;
  url?: string;
}

export function encodeMcpUi(payload: McpUiPayload): string {
  return MCPUI_MARKER + JSON.stringify(payload);
}

export function parseMcpUi(value: string): McpUiPayload | null {
  if (typeof value !== "string" || !value.startsWith(MCPUI_MARKER)) return null;
  try {
    const p = JSON.parse(value.slice(MCPUI_MARKER.length)) as McpUiPayload;
    return p.html || p.url ? p : null;
  } catch {
    return null;
  }
}
