import "server-only";
import type { ToolGateConfig } from "./tools";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";
import { readMetadataOverrides } from "@/lib/agent/tool-metadata-overrides";
import { getAgent } from "@/lib/agent/subagents/store";

// Per-run tool gate (016 allowlist + 025 deferred + Settings description
// overrides), mirroring the old withToolGate options. Lives in its own module
// so both the registry and the discovery tools can use it without a cycle.
// Deferred is a purely per-agent decision (`agent.deferredTools`, edited in
// Settings → Agents → [agent] → Tools) — there is no registry-wide default.
export async function gateFor(agentId: string): Promise<ToolGateConfig> {
  const agent = await getAgent(agentId).catch(() => undefined);
  const overrides = await readMetadataOverrides().catch(() => ({}) as Record<string, { description?: string }>);
  return {
    allow: new Set(agent?.tools ?? []),
    deferred: new Set(agent?.deferredTools ?? []),
    registryIds: new Set(CAPABILITIES.map((c) => c.id)),
    descriptions: Object.fromEntries(Object.entries(overrides).map(([id, o]) => [id, o?.description])),
  };
}
