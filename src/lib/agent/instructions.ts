import "server-only";
import { CORE_POLICY, DEFAULT_PERSONALITY } from "./config";
import { getAgent } from "./subagents/store";
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
// then a skills index (full skill bodies loaded on demand via skill_load). The
// skills index is filtered to the agent's allowed skills (011-per-agent-capabilities;
// unset = all).
//
// `agentId` is REQUIRED and must resolve to a real agent — there is no global
// "active agent" to fall back to. A missing/unknown id is a bug (a request that
// didn't carry the conversation's agent), so we throw rather than silently
// composing the wrong personality.
export async function composeInstructions(agentId: string): Promise<string> {
  const id = (agentId ?? "").trim();
  if (!id) throw new Error("composeInstructions requires an agentId (no active-agent fallback).");
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
    out += `\n\n## Skills\nYou have a skill library. When a skill is relevant, call skill_load to read its full instructions, then follow them. A skill's instructions may point to bundled files — open referenced docs and scripts with skill_read_file. To RUN a skill's scripts, call run_command with skill=<the skill id>: its files are staged into the working directory, so the relative commands in its SKILL.md (e.g. \`python scripts/office/unpack.py\`) work as-written.\n${index}`;
  }
  // MCP servers as an INDEX, not their tools (014-mcp-tool-gateway): the agent
  // searches/lists tools (with schemas) and calls them on demand, so context stays
  // small regardless of how many tools a server exposes.
  const allowedMcp = mcpServers.filter((s) => isAllowed(agent?.mcp, s.name, s.endpoint ?? ""));
  if (allowedMcp.length > 0) {
    const index = allowedMcp.map((s) => `- ${s.name}: ${mcpDescription(s)}`).join("\n");
    out += `\n\n## MCP servers\nExternal tools are available through MCP servers — their tools are NOT listed as direct functions. To use one: call searchMcpTools to find the right tool, getMcpToolSchema to inspect its input schema, then callMcpTool with arguments matching that schema. You can also listMcpServerTools for a full server listing.\n${index}`;
  }
  return out;
}
