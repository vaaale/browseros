import "server-only";
import type { AssistantTool, ToolGateConfig } from "./tools";
import { gateFor } from "./gate";
import { composeInstructions, buildSkillsIndexBlock, buildMcpIndexBlock, buildKbIndexBlock, buildToolGroupsBlock, currentDateTimeBlock } from "@/lib/agent/instructions";
import { getDefaultPromptAgent } from "@/lib/agent/subagents/store";
import { listSkills } from "@/lib/agent/skills/store";
import { listMcpServers } from "@/lib/mcp/store";
import { listKnowledgeBases } from "@/lib/agent/kb-catalog";

// Per-delegation-kind gate + system-prompt builders (025-agent-delegation-v2).
// A named agent's gate/prompt are unchanged from today's primary-personality
// path (FR-005) — only the RESOLUTION happens through the unified registry
// now. Ephemeral and surface agents get purpose-built, structurally-incapable-
// of-being-empty gates (FR-003/FR-004/FR-007/FR-025), never a separately
// configured `tools:` field.

// Tools that orchestrate other agents. Sub-agents never get these — only the
// top-level agent is the orchestrator; allowing sub-agents to delegate further
// creates unbounded delegation chains.
const ORCHESTRATION_TOOLS = new Set(["agent_delegate", "dev_delegate", "agent_list"]);

function stripOrchestrationTools(gate: ToolGateConfig): ToolGateConfig {
  return {
    ...gate,
    allow: new Set([...gate.allow].filter((id) => !ORCHESTRATION_TOOLS.has(id))),
    deferred: new Set([...gate.deferred].filter((id) => !ORCHESTRATION_TOOLS.has(id))),
  };
}

/** Named agent: reuse gateFor(agentId), then strip orchestration tools. */
export async function namedDelegationGate(agentId: string): Promise<ToolGateConfig> {
  return stripOrchestrationTools(await gateFor(agentId));
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
  return stripOrchestrationTools({
    allow: serverOnlyIds(parentGate.allow, tools),
    deferred: new Set(),
    registryIds: parentGate.registryIds,
    descriptions: parentGate.descriptions,
  });
}

/** Surface agent: exactly the app-declared `toolNames`, immediately visible
 *  (FR-007). `registryIds`/`descriptions` are reused from the parent's gate —
 *  a "real" registered capability (e.g. ui_preview_generate) needs to be in `allow` to
 *  pass visibleTools()'s check, which it is; a Tier-2 tool never added to
 *  CAPABILITIES bypasses the allow-check entirely, same as it does today for
 *  the primary personality (FR-025). */
export function surfaceDelegationGate(toolNames: string[], parentGate: ToolGateConfig): ToolGateConfig {
  return stripOrchestrationTools({
    allow: new Set(toolNames),
    deferred: new Set(),
    registryIds: parentGate.registryIds,
    descriptions: parentGate.descriptions,
  });
}

/** Named agent: identical composition to the primary-personality path — this
 *  is a deliberate small upgrade over today's legacy behavior (bare
 *  `agent.systemPrompt`, no default-prompt/memory/skills-index/mcp-index at
 *  all), since FR-005's whole point is "resolved identically regardless of
 *  invocation context." */
export function namedComposeSystem(
  agentId: string,
  run?: { gate: ToolGateConfig; tools: Record<string, AssistantTool> },
): () => Promise<string> {
  return () => composeInstructions(agentId, run);
}

/** Ephemeral agent: default prompt + systemPrompt as personality, plus the
 *  inherited skills/mcp/kbs index blocks (FR-016; kbs per 038-knowledge-base),
 *  filtered against the DELEGATING agent's own `skills`/`mcp`/`kbs` fields
 *  (unset ⇒ inherit everything — `buildSkillsIndexBlock`/`buildMcpIndexBlock`/
 *  `buildKbIndexBlock` are already unset-aware). No memory snapshot (FR-017 —
 *  an ephemeral agent has no identity to have memory of). */
export function ephemeralComposeSystem(
  systemPrompt: string,
  parentAllowlists: { skills?: string[]; mcp?: string[]; kbs?: string[] },
  // 041-tool-groups: an ephemeral agent's gate has an EMPTY deferred set, so its
  // block lists groups with no "more available here" lines — which is correct
  // and is exactly why the block must be built from the gate rather than from an
  // agent record. Without this it would receive no tool guidance at all, since
  // it never reads an AGENT.md.
  run?: { gate: ToolGateConfig; tools: Record<string, AssistantTool> },
): () => Promise<string> {
  return async () => {
    const [skills, mcpServers, kbs, defaultAgent] = await Promise.all([
      listSkills(),
      listMcpServers(),
      listKnowledgeBases(),
      getDefaultPromptAgent(),
    ]);
    const defaultBody = defaultAgent?.systemPrompt?.trim() || "";
    let out = currentDateTimeBlock() + "\n\n";
    out += defaultBody ? `${defaultBody}\n\n## Personality\n${systemPrompt}` : systemPrompt;
    out += buildSkillsIndexBlock(parentAllowlists.skills, skills);
    out += buildMcpIndexBlock(parentAllowlists.mcp, mcpServers);
    out += buildKbIndexBlock(parentAllowlists.kbs, kbs);
    if (run) out += await buildToolGroupsBlock(run.gate, run.tools);
    return out;
  };
}

/** Surface agent: default prompt + systemPrompt as its personality, nothing
 *  else appended (FR-017) — the registering app supplies the bounded toolset
 *  and personality, but still inherits the shared default prompt. */
export function surfaceComposeSystem(
  systemPrompt: string,
  run?: { gate: ToolGateConfig; tools: Record<string, AssistantTool> },
): () => Promise<string> {
  return async () => {
    const defaultAgent = await getDefaultPromptAgent();
    const defaultBody = defaultAgent?.systemPrompt?.trim() || "";
    const head = defaultBody
      ? `${currentDateTimeBlock()}\n\n${defaultBody}\n\n## Personality\n${systemPrompt}`
      : `${currentDateTimeBlock()}\n\n${systemPrompt}`;
    // 041-tool-groups: a surface agent's toolset is app-declared and fully
    // visible, so it gets the group index with no discovery lines.
    return run ? head + (await buildToolGroupsBlock(run.gate, run.tools)) : head;
  };
}
