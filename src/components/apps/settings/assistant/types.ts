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
}

// The default agent slot the main assistant adopts as its personality. It is
// protected server-side (deleteSubAgent throws) — mirrored here so the client
// can hide the delete affordance without a round-trip.
export const PROTECTED_AGENT_ID = "assistant";
