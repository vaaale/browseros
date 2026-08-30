import "server-only";
import type { Agent } from "./types";

// ADR-12 (Workflow Manager service-tools): a headless EPHEMERAL agent is never
// persisted (there is no data/agents/<id>), so `getAgent(id)` — and therefore
// `gateFor(id)` — is undefined for it. The discovery tool (`find_tools`,
// tools/server/discovery.ts) resolves a run's gate from `ctx.agentId`; for an
// ephemeral agent that yields an empty gate and `find_tools` returns `[]`.
//
// This tiny registry maps a headless run's runId → its in-memory Agent object,
// so `find_tools` can build the gate from the ACTUAL object the run is using.
// Only ephemeral runs register (runLocalHeadless), so a named agent's runId is
// never present here and named-agent discovery stays byte-identical to
// pre-patch (it still resolves via `gateFor(agentId)`).
//
// Lives on globalThis (same hot-reload-safe pattern as run-manager.ts) so Next.js
// dev recompiles don't orphan registered runs.

const g = globalThis as unknown as { __bosInRunAgents?: Map<string, Agent> };

function store(): Map<string, Agent> {
  if (!g.__bosInRunAgents) g.__bosInRunAgents = new Map();
  return g.__bosInRunAgents;
}

/** Register a run's in-memory (ephemeral) agent so discovery can resolve its gate. */
export function setInRunAgent(runId: string, agent: Agent): void {
  store().set(runId, agent);
}

/** The in-memory agent registered for a run, if any (undefined for named/headless
 *  runs that were not registered). */
export function getInRunAgent(runId: string): Agent | undefined {
  return store().get(runId);
}

/** Drop a run's registration (called from the run's `finally`). */
export function clearInRunAgent(runId: string): void {
  store().delete(runId);
}
