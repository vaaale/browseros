import "server-only";
import { listSubAgents } from "@/lib/agent/subagents/store";
import type { ValidationResult, Workflow } from "./types";

const STEP_TYPES = new Set(["delegate", "tool", "ag-ui"]);

/** Kahn's algorithm: returns true if the step graph is acyclic. */
function isAcyclic(wf: Workflow): boolean {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of wf.steps) {
    inDeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of wf.steps) {
    for (const dep of s.dependencies ?? []) {
      if (!inDeg.has(dep)) continue; // missing dep handled elsewhere
      inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
      adj.get(dep)!.push(s.id);
    }
  }
  const queue: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    visited++;
    for (const next of adj.get(cur) ?? []) {
      const d = (inDeg.get(next) ?? 0) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return visited === wf.steps.length;
}

export async function validateWorkflow(wf: Workflow): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!wf.id) errors.push("Workflow is missing an id.");
  if (!wf.name) warnings.push("Workflow has no name.");
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) errors.push("Workflow must have at least one step.");
  if (!Array.isArray(wf.agents)) errors.push("Workflow agents must be an array.");

  const stepIds = new Set<string>();
  for (const s of wf.steps ?? []) {
    if (!s.id) {
      errors.push("A step is missing an id.");
      continue;
    }
    if (stepIds.has(s.id)) errors.push(`Duplicate step id: ${s.id}.`);
    stepIds.add(s.id);
    if (!STEP_TYPES.has(s.type)) errors.push(`Step "${s.id}" has invalid type "${s.type}".`);
  }

  const wfAgentIds = new Set((wf.agents ?? []).map((a) => a.id));
  for (const s of wf.steps ?? []) {
    if (s.type === "delegate" || s.type === "tool") {
      if (!s.agentId) errors.push(`Step "${s.id}" (${s.type}) requires an agentId.`);
      else if (!wfAgentIds.has(s.agentId)) errors.push(`Step "${s.id}" references unknown agent "${s.agentId}".`);
    }
    if (s.type === "tool" && !s.toolName) errors.push(`Step "${s.id}" (tool) requires a toolName.`);
    for (const dep of s.dependencies ?? []) {
      if (!stepIds.has(dep)) errors.push(`Step "${s.id}" depends on missing step "${dep}".`);
    }
  }

  if (wf.steps && wf.steps.length > 0 && !isAcyclic(wf)) {
    errors.push("Workflow has a dependency cycle.");
  }

  // Cross-check workflow agents against real sub-agents in data/agents.
  try {
    const subAgents = await listSubAgents();
    const known = new Set(subAgents.map((a) => a.id.toLowerCase()));
    const knownByName = new Set(subAgents.map((a) => a.name.toLowerCase()));
    for (const a of wf.agents ?? []) {
      const ok = known.has(a.id.toLowerCase()) || knownByName.has(a.id.toLowerCase());
      if (!ok) errors.push(`Workflow agent "${a.id}" does not exist in data/agents.`);
    }
  } catch (e) {
    warnings.push(`Could not verify sub-agents: ${(e as Error).message}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
