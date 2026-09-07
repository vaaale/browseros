import "server-only";
import { getAgent, getDefaultPromptAgent } from "./subagents/store";
import { listSkills } from "./skills/store";
import type { Skill } from "./skills/store";
import { memorySnapshotForAgent } from "./memory/agent-memory";
import { listMcpServers } from "@/lib/mcp/store";
import { filterAllowed, isAllowed } from "./capabilities";
import type { McpServerConfig } from "@/lib/mcp/types";
import { listKnowledgeBases } from "./kb-catalog";
import type { KnowledgeBaseCatalogEntry } from "./kb-catalog";
import { listCapabilities } from "./capabilities-registry";
import { getEffectiveGroups } from "./tool-group-overrides";
import type { AssistantTool, ToolGateConfig } from "@/lib/assistant/tools";

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
  return `\n\n## MCP servers\nExternal tools are available through MCP servers — their tools are NOT listed as direct functions, and find_tools does not reach them. To use one: call mcp_tool_search to find the right tool, mcp_tool_schema to inspect its input schema, then mcp_tool_call with arguments matching that schema. You can also call mcp_server_tools for a full server listing.\n${index}`;
}

/** The "## Knowledge bases" block for the KBs allowed by `allowedKbs` (unset ⇒
 *  all), or "" if none are allowed (038-knowledge-base; mirrors
 *  buildSkillsIndexBlock — the agent is told which KBs are available so its
 *  kb_search/kb_retrieve are limited to those, by availability). */
export function buildKbIndexBlock(allowedKbs: string[] | undefined, kbs: KnowledgeBaseCatalogEntry[]): string {
  const allowed = filterAllowed(allowedKbs, kbs, (kb) => kb.id);
  if (allowed.length === 0) return "";
  const index = allowed.map((kb) => `- ${kb.name}${kb.description ? `: ${kb.description}` : ""}`).join("\n");
  return `\n\n## Knowledge bases\nYou have access to the following knowledge bases via the Knowledge Base item's MCP tools (kb_search / kb_retrieve), reached the same way as any other MCP tool. Only these knowledge bases are queryable — one not listed here is not available to you.\n${index}`;
}

/**
 * The "## Tool groups" block (041-tool-groups) — the fourth index block,
 * deliberately the same shape as Skills / MCP servers / Knowledge bases: an
 * index plus how to expand it.
 *
 * Why it exists at all: the provider's native tool field is a FLAT list with no
 * group metadata in either the Anthropic or the OpenAI wire format, so grouping
 * can only be expressed prompt-side. And a deferred tool is invisible by
 * design, so without an index the agent has to already suspect a capability
 * exists before it can search for it.
 *
 * Derived from the run's GATE, not from an agent record, so named, ephemeral
 * and surface-delegated agents each get a block matching what they can actually
 * call (FR-010). Static for the run — it must not encode which tools have
 * already been revealed (FR-011), or every step would invalidate the cached
 * system block.
 */
export async function buildToolGroupsBlock(
  gate: ToolGateConfig,
  tools: Record<string, AssistantTool>,
): Promise<string> {
  const caps = listCapabilities();
  const byId = new Map(caps.map((c) => [c.id, c]));

  // Only ids that are granted AND resolve against the live registry AND have a
  // real tool behind them. Non-registry tools (find_tools/find_agent, consent
  // and elicitation, window-scoped surface Tier-2 tools) are excluded BY
  // CONSTRUCTION here: they have no Capability, therefore no group. Never
  // synthesize a bucket for them — there is no fallback group (FR-005/FR-041).
  const granted = [...gate.allow]
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined && tools[c.id] !== undefined);
  if (granted.length === 0) return "";

  const groups = await getEffectiveGroups();
  const membership = new Map<string, { visible: string[]; hidden: number }>();
  for (const cap of granted) {
    const entry = membership.get(cap.group) ?? { visible: [], hidden: 0 };
    if (gate.deferred.has(cap.id)) entry.hidden += 1;
    else entry.visible.push(cap.id);
    membership.set(cap.group, entry);
  }

  // Group order comes from the group table (built-ins in canonical order, then
  // dynamic groups by id), not from capability order (FR-012) — so a service
  // restarting doesn't reshuffle the cacheable prefix of the prompt.
  const lines: string[] = [];
  let anyHidden = false;
  for (const group of groups) {
    const entry = membership.get(group.id);
    if (!entry) continue; // a group with nothing granted is not the agent's (FR-007)
    lines.push(`${group.name.toUpperCase()} — ${group.description}`);
    // Visible tools are NAMED; hidden tools are only COUNTED (FR-015). Naming
    // the hidden ones would defeat deferral; counting them does not.
    if (entry.visible.length > 0) lines.push(`  ${entry.visible.join(", ")}`);
    if (entry.hidden > 0) {
      anyHidden = true;
      lines.push(
        `  ${entry.hidden} more available here — call find_tools(group: "${group.id}") to see ${entry.hidden === 1 ? "it" : "them"}`,
      );
    }
    lines.push("");
  }
  if (lines.length === 0) return "";

  const preamble = [
    "These are the tool families available to you. Tools listed by name are already callable.",
    anyHidden
      ? 'Where a group says "more available here", those tools exist but are hidden to keep this list short — call find_tools to bring them into your toolset for the rest of the conversation.'
      : "",
    "Use find_tools whenever no visible tool fits, or when the task suggests a specialized tool should exist. It searches by natural language (`query`) or returns a whole group (`group`).",
    "find_tools does NOT reach MCP server tools — those live behind mcp_tool_search / mcp_tool_schema / mcp_tool_call.",
  ]
    .filter(Boolean)
    .join(" ");

  return `\n\n## Tool groups\n${preamble}\n\n${lines.join("\n").trimEnd()}`;
}

/** What composeInstructions needs to build the tool-group block: the run's
 *  effective gate and the tool map it was gated against. */
export interface ToolGroupsContext {
  gate: ToolGateConfig;
  tools: Record<string, AssistantTool>;
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
export async function composeInstructions(agentId: string, run?: ToolGroupsContext): Promise<string> {
  const id = (agentId ?? "").trim();
  if (!id) throw new Error("composeInstructions requires an agentId (no active-agent fallback).");
  const [agent, defaultAgent, skills, memory, mcpServers, kbs] = await Promise.all([
    getAgent(id),
    getDefaultPromptAgent(),
    listSkills(),
    memorySnapshotForAgent(id),
    listMcpServers(),
    listKnowledgeBases(),
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
  out += buildKbIndexBlock(agent?.kbs, kbs);
  // 041-tool-groups: omitted rather than guessed at when the caller didn't pass
  // the run's gate — a block built from the wrong gate would advertise tools the
  // agent cannot call.
  if (run) out += await buildToolGroupsBlock(run.gate, run.tools);
  return out;
}
