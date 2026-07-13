import "server-only";
import type { AssistantTool, ToolGateConfig } from "./tools";
import { gateFor } from "./gate";
import { composeInstructions, buildSkillsIndexBlock, buildMcpIndexBlock } from "@/lib/agent/instructions";
import { listSkills } from "@/lib/agent/skills/store";
import { listMcpServers } from "@/lib/mcp/store";

// Per-delegation-kind gate + system-prompt builders (025-agent-delegation-v2).
// A named agent's gate/prompt are unchanged from today's primary-personality
// path (FR-005) — only the RESOLUTION happens through the unified registry
// now. Ephemeral and surface agents get purpose-built, structurally-incapable-
// of-being-empty gates (FR-003/FR-004/FR-007/FR-025), never a separately
// configured `tools:` field.

/** Named agent: reuse gateFor(agentId) unchanged. */
export function namedDelegationGate(agentId: string): Promise<ToolGateConfig> {
  return gateFor(agentId);
}

function serverOnlyIds(allow: Set<string>, tools: Record<string, AssistantTool>): Set<string> {
  return new Set([...allow].filter((id) => tools[id]?.execution === "server"));
}

/** Ephemeral agent: every SERVER-executable tool in the parent's full
 *  allowlist, immediately visible (FR-003/FR-004) — deferred status on the
 *  PARENT is irrelevant to eligibility, and there is no deferred layer of its
 *  own. Frontend/Tier-2 tools are deliberately excluded — see spec.md's
 *  Clarifications for why this is a scope line, not a technical limitation. */
export function ephemeralDelegationGate(parentGate: ToolGateConfig, tools: Record<string, AssistantTool>): ToolGateConfig {
  return {
    allow: serverOnlyIds(parentGate.allow, tools),
    deferred: new Set(),
    registryIds: parentGate.registryIds,
    descriptions: parentGate.descriptions,
  };
}

/** Surface agent: exactly the app-declared `toolNames`, immediately visible
 *  (FR-007). `registryIds`/`descriptions` are reused from the parent's gate —
 *  a "real" registered capability (e.g. a2ui_render) needs to be in `allow` to
 *  pass visibleTools()'s check, which it is; a Tier-2 tool never added to
 *  CAPABILITIES bypasses the allow-check entirely, same as it does today for
 *  the primary personality (FR-025). */
export function surfaceDelegationGate(toolNames: string[], parentGate: ToolGateConfig): ToolGateConfig {
  return {
    allow: new Set(toolNames),
    deferred: new Set(),
    registryIds: parentGate.registryIds,
    descriptions: parentGate.descriptions,
  };
}

/** Named agent: identical composition to the primary-personality path — this
 *  is a deliberate small upgrade over today's legacy behavior (bare
 *  `agent.systemPrompt`, no default-prompt/memory/skills-index/mcp-index at
 *  all), since FR-005's whole point is "resolved identically regardless of
 *  invocation context." */
export function namedComposeSystem(agentId: string): () => Promise<string> {
  return () => composeInstructions(agentId);
}

/** Ephemeral agent: systemPrompt verbatim + the inherited skills/mcp index
 *  blocks (FR-016), filtered against the DELEGATING agent's own `skills`/`mcp`
 *  fields (unset ⇒ inherit everything — `buildSkillsIndexBlock`/
 *  `buildMcpIndexBlock` are already unset-aware). No default-prompt
 *  prepending, no memory snapshot (FR-017 — an ephemeral agent has no
 *  identity to have memory of). */
export function ephemeralComposeSystem(
  systemPrompt: string,
  parentAllowlists: { skills?: string[]; mcp?: string[] },
): () => Promise<string> {
  return async () => {
    const [skills, mcpServers] = await Promise.all([listSkills(), listMcpServers()]);
    let out = systemPrompt;
    out += buildSkillsIndexBlock(parentAllowlists.skills, skills);
    out += buildMcpIndexBlock(parentAllowlists.mcp, mcpServers);
    return out;
  };
}

/** Surface agent: systemPrompt verbatim, nothing appended (FR-017) — the
 *  registering app supplies a complete prompt for its own bounded toolset. */
export function surfaceComposeSystem(systemPrompt: string): () => Promise<string> {
  return async () => systemPrompt;
}
