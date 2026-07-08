import type { McpToolDescriptor } from "./types";

// v1 tool matcher for the MCP gateway (014-mcp-tool-gateway). Pure and isolated
// (no server-only deps) so it is unit-testable AND can be swapped for semantic
// search later WITHOUT changing the gateway or the tool contract.
//
// Case-insensitive. `*` = any run of chars, `?` = one char; with no wildcard it's
// a plain substring search. Matches over the tool name + description.
export function makeToolMatcher(query: string): (t: McpToolDescriptor) => boolean {
  const q = query.trim().toLowerCase();
  if (!q) return () => true;
  const hay = (t: McpToolDescriptor) => `${t.name}\n${t.description ?? ""}`.toLowerCase();
  if (/[*?]/.test(q)) {
    const rx = new RegExp(
      q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."),
      "i",
    );
    return (t) => rx.test(hay(t));
  }
  return (t) => hay(t).includes(q);
}
