import "server-only";
import type { ToolGateConfig } from "./tools";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";
import { readMetadataOverrides } from "@/lib/agent/tool-metadata-overrides";
import { getAgent } from "@/lib/agent/subagents/store";
import type { Agent } from "@/lib/agent/subagents/types";
import { logger } from "@/lib/logging";

// Per-run tool gate (016 allowlist + 025 deferred + Settings description
// overrides), mirroring the old withToolGate options. Lives in its own module
// so both the registry and the discovery tools can use it without a cycle.
// Deferred is a purely per-agent decision (`agent.deferredTools`, edited in
// Settings → Agents → [agent] → Tools) — there is no registry-wide default.

// Never flagged as "unresolved" — these are always-available discovery tools
// (tools.ts's DISCOVERY_TOOLS), not registry-gated, so an agent naming them
// explicitly (redundant but harmless) is not a real configuration error.
const ALWAYS_AVAILABLE = new Set(["find_tools", "find_agent"]);

/** Tool ids in `ids` that do not resolve against the capability registry
 *  (025-agent-delegation-v2, FR-023) — never silently dropped, per the
 *  standing no-silent-failures policy. */
export function unresolvedToolIds(ids: string[] | undefined, registryIds: Set<string>): string[] {
  return (ids ?? []).filter((id) => !registryIds.has(id) && !ALWAYS_AVAILABLE.has(id));
}

/** Build a gate directly from an already-in-hand Agent object — no `getAgent`
 *  lookup, so this also works for an ad-hoc (non-persisted) Agent, e.g. a
 *  workflow's ephemeral tool-step clone (`workflows/runner.ts`), which is
 *  never written to `data/agents/`. */
export async function gateFromAgent(agent: Agent | undefined): Promise<ToolGateConfig> {
  const overrides = await readMetadataOverrides().catch(() => ({}) as Record<string, { description?: string }>);
  const registryIds = new Set(CAPABILITIES.map((c) => c.id));

  const unresolved = [...unresolvedToolIds(agent?.tools, registryIds), ...unresolvedToolIds(agent?.deferredTools, registryIds)];
  if (unresolved.length > 0) {
    logger().warn("assistant.agents", "agent references unresolved tool ids", {
      agentId: agent?.id,
      unresolvedIds: [...new Set(unresolved)],
    });
  }

  return {
    allow: new Set(agent?.tools ?? []),
    deferred: new Set(agent?.deferredTools ?? []),
    registryIds,
    descriptions: Object.fromEntries(Object.entries(overrides).map(([id, o]) => [id, o?.description])),
  };
}

export async function gateFor(agentId: string): Promise<ToolGateConfig> {
  const agent = await getAgent(agentId).catch(() => undefined);
  return gateFromAgent(agent);
}
