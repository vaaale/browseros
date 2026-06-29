import "server-only";
import { CORE_POLICY, DEFAULT_PERSONALITY } from "./config";
import { getActiveAgentId, getAgent } from "./subagents/store";
import { listSkills } from "./skills/store";
import { memorySnapshot } from "./memory/curated";
import { listMcpServers } from "@/lib/mcp/store";
import { filterAllowed, isAllowed } from "./capabilities";
import type { McpServerConfig } from "@/lib/mcp/types";

function mcpDescription(s: McpServerConfig): string {
  return s.description?.trim() || `${s.transport ?? "http"} MCP server`;
}

// Composes the assistant's system instructions: always-on core policy, the
// agent's personality, the curated memory snapshot (frozen for the session),
// then a skills index (full skill bodies loaded on demand via loadSkill). The
// skills index is filtered to the agent's allowed skills (011-per-agent-capabilities;
// unset = all). Pass an explicit agentId to compose for an embed's pinned agent
// (012-embeddable-assistant); defaults to the globally active agent.
export async function composeInstructions(agentId?: string): Promise<string> {
  const id = agentId ?? (await getActiveAgentId());
  const [agent, skills, memory, mcpServers] = await Promise.all([
    getAgent(id),
    listSkills(),
    memorySnapshot(),
    listMcpServers(),
  ]);
  const personality = agent?.systemPrompt?.trim() || DEFAULT_PERSONALITY;
  let out = `${CORE_POLICY}\n\n## Personality\n${personality}`;
  if (memory) out += `\n\n${memory}`;
  const allowed = filterAllowed(agent?.skills, skills, (s) => s.id);
  if (allowed.length > 0) {
    const index = allowed
      .map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
      .join("\n");
    out += `\n\n## Skills\nYou have a skill library. When a skill is relevant, call loadSkill to read its full instructions, then follow them.\n${index}`;
  }
  // MCP servers as an INDEX, not their tools (014-mcp-tool-gateway): the agent
  // searches/lists tools (with schemas) and calls them on demand, so context stays
  // small regardless of how many tools a server exposes.
  const allowedMcp = mcpServers.filter((s) => isAllowed(agent?.mcp, s.name, s.endpoint ?? ""));
  if (allowedMcp.length > 0) {
    const index = allowedMcp.map((s) => `- ${s.name}: ${mcpDescription(s)}`).join("\n");
    out += `\n\n## MCP servers\nExternal tools are available through MCP servers — their tools are NOT listed as direct functions. To use one: call findTools to search across servers, or listMcpServerTools for a specific server (both return input schemas), then call the chosen tool with callMcpServerTool.\n${index}`;
  }
  return out;
}
