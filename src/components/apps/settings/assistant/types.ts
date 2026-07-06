// Shape of an agent as returned by GET /api/assistant/agent — the AGENT.md
// frontmatter plus its system prompt body (needed by the details pane).
export interface AgentMeta {
  id: string;
  name: string;
  description: string;
  type: string;
  tools: string[];
  skills: string[];
  mcp: string[];
  systemPrompt: string;
  /** Whether the shared default prompt is prepended to this agent's personality.
   *  Defaults to true server-side when the AGENT.md doesn't set it explicitly. */
  useDefaultPrompt: boolean;
}

// One skill entry in the catalog returned alongside `agents` by GET
// /api/assistant/agent. The description powers the Skills-Grid card body; the
// UI shows "No description available" when it's empty.
export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
}

// One MCP server entry in the catalog. `endpoint` is a display-only fallback
// derived server-side (http URL or stdio command line) when no description
// exists.
export interface CatalogMcp {
  name: string;
  description: string;
  endpoint: string;
}

// One capability entry — mirrors src/lib/agent/capabilities-registry.ts so the
// client renders the ToolAccordions without importing server-only code.
export interface CatalogTool {
  id: string;
  group: string;
  description: string;
  context: "action" | "tool" | "both";
}

export interface Catalog {
  tools: CatalogTool[];
  skills: CatalogSkill[];
  mcp: CatalogMcp[];
}

// The subset of capability arrays this UI writes back to the agent. Undefined
// classes are preserved on the server (setAgentCapabilities semantics).
export interface CapabilitiesPatch {
  tools?: string[];
  skills?: string[];
  mcp?: string[];
}

// The default agent slot the main assistant adopts as its personality. It is
// protected server-side (deleteSubAgent throws) — mirrored here so the client
// can hide the delete affordance without a round-trip.
export const PROTECTED_AGENT_ID = "assistant";
