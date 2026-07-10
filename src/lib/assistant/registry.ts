import "server-only";
import type { AssistantTool, ToolGateConfig } from "./tools";
import { CAPABILITIES, deferredCapabilityIds } from "@/lib/agent/capabilities-registry";
import { readMetadataOverrides } from "@/lib/agent/tool-metadata-overrides";
import { getAgent } from "@/lib/agent/subagents/store";

// The assistant tool registry. Milestone C ports the ~60 tools from the
// *Actions.tsx files here (fetch-wrappers become server tools calling their lib
// functions directly; OS-store tools and elicitations stay frontend). Until
// then the loop runs with whatever a surface contributes per run.

export function assistantTools(): Record<string, AssistantTool> {
  return {};
}

/** Build the per-run gate config from the agent's allowlists + overrides,
 *  mirroring today's withToolGate options. */
export async function gateFor(agentId: string): Promise<ToolGateConfig> {
  const agent = await getAgent(agentId).catch(() => undefined);
  const overrides = await readMetadataOverrides().catch(() => ({}) as Record<string, { description?: string }>);
  return {
    allow: new Set(agent?.tools ?? []),
    deferred: new Set([...deferredCapabilityIds(), ...(agent?.deferredTools ?? [])]),
    registryIds: new Set(CAPABILITIES.map((c) => c.id)),
    descriptions: Object.fromEntries(Object.entries(overrides).map(([id, o]) => [id, o?.description])),
  };
}
