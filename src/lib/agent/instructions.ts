import "server-only";
import { getAgent, getDefaultPromptAgent } from "./subagents/store";
import { listSkills } from "./skills/store";
import type { Skill } from "./skills/store";
import { memorySnapshotForAgent } from "./memory/agent-memory";
import { listMcpServers } from "@/lib/mcp/store";
import { filterAllowed, isAllowed } from "./capabilities";
import type { McpServerConfig } from "@/lib/mcp/types";

function mcpDescription(s: McpServerConfig): string {
  return s.description?.trim() || `${s.transport ?? "http"} MCP server`;
}

// Skills/MCP index-block builders (025-agent-delegation-v2), factored out of
// composeInstructions so an ephemeral agent's prompt builder can reuse the
// EXACT same block text against its own inherited allowlist, instead of
// duplicating the templates. `filterAllowed`/`isAllowed` are already
// unset-aware (unset/empty allowlist ⇒ everything allowed, `capabilities.ts`)
// — callers must pass the allowlist through untouched, never substitute a
// `.length > 0` check first, or an unset ("inherit everything") allowlist
// would be misread as "nothing inherited."

/** The "## Skills" block for the skills allowed by `allowedSkills` (unset ⇒
 *  all), or "" if none are allowed. */
export function buildSkillsIndexBlock(allowedSkills: string[] | undefined, skills: Skill[]): string {
  const allowed = filterAllowed(allowedSkills, skills, (s) => s.id);
  if (allowed.length === 0) return "";
  const index = allowed
    .map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (use when: ${s.whenToUse})` : ""}`)
    .join("\n");
  return `\n\n## Skills\nYou have a skill library. When a skill is relevant, call skill_load to read its full instructions, then follow them. A skill's instructions may point to bundled files — open referenced docs and scripts with skill_read_file. To RUN a skill's scripts, call run_command with skill=<the skill id>: its files are staged into the working directory, so the relative commands in its SKILL.md (e.g. \`python scripts/office/unpack.py\`) work as-written.\n${index}`;
}

/** The "## MCP servers" block for the servers allowed by `allowedMcp` (unset
 *  ⇒ all), or "" if none are allowed. */
export function buildMcpIndexBlock(allowedMcp: string[] | undefined, mcpServers: McpServerConfig[]): string {
  const allowed = mcpServers.filter((s) => isAllowed(allowedMcp, s.name, s.endpoint ?? ""));
  if (allowed.length === 0) return "";
  const index = allowed.map((s) => `- ${s.name}: ${mcpDescription(s)}`).join("\n");
  return `\n\n## MCP servers\nExternal tools are available through MCP servers — their tools are NOT listed as direct functions. To use one: call searchMcpTools to find the right tool, getMcpToolSchema to inspect its input schema, then callMcpTool with arguments matching that schema. You can also listMcpServerTools for a full server listing.\n${index}`;
}

export function currentDateTimeBlock(): string {
  return `Current date/time: ${new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`;
}

// Composes the assistant's system instructions: an optional shared default
// prompt (edited in Settings → Agents → Default Agent, opt-in per-agent via
// useDefaultPrompt), the agent's personality, the curated memory snapshot
// (frozen for the session), then a skills index (full skill bodies loaded on
// demand via skill_load). The skills index is filtered to the agent's allowed
// skills (011-per-agent-capabilities; unset = all).
//
// `agentId` is REQUIRED and must resolve to a real agent — there is no global
// "active agent" to fall back to. A missing/unknown id is a bug (a request that
// didn't carry the conversation's agent), so we throw rather than silently
// composing the wrong personality.
export async function composeInstructions(agentId: string): Promise<string> {
  const id = (agentId ?? "").trim();
  if (!id) throw new Error("composeInstructions requires an agentId (no active-agent fallback).");
  const [agent, defaultAgent, skills, memory, mcpServers] = await Promise.all([
    getAgent(id),
    getDefaultPromptAgent(),
    listSkills(),
    memorySnapshotForAgent(id),
    listMcpServers(),
  ]);
  const personality = agent?.systemPrompt?.trim() || "";
  const includeDefault = agent?.useDefaultPrompt ?? true;
  const defaultBody = includeDefault ? (defaultAgent?.systemPrompt?.trim() || "") : "";
  let out = currentDateTimeBlock() + "\n\n";
  out += defaultBody
    ? personality
      ? `${defaultBody}\n\n## Personality\n${personality}`
      : defaultBody
    : personality;
  if (memory) out += `\n\n${memory}`;
  out += buildSkillsIndexBlock(agent?.skills, skills);
  // MCP servers as an INDEX, not their tools (014-mcp-tool-gateway): the agent
  // searches/lists tools (with schemas) and calls them on demand, so context stays
  // small regardless of how many tools a server exposes.
  out += buildMcpIndexBlock(agent?.mcp, mcpServers);
  return out;
}
