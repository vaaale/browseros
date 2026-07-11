// The assistant tool contract (framework-free). ONE registry describes every
// tool; `execution` decides where it runs:
//   - "server": executed inline by the agent loop via `execute` (kernel-style
//     guarantees: caught, timed out, in-band `Error: …` strings).
//   - "frontend": declared here (or contributed per-run by a surface via
//     `surfaceTools`), dispatched to an attached browser which executes the
//     bound handler through the client tool kernel and posts the result back.
// Tool gating (016 allowlist + 025 deferred (per-agent, see gate.ts) +
// description overrides) is applied by the loop from this shape — see
// agent-loop.ts.

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  signal: AbortSignal;
  conversationId: string;
  agentId: string;
  /** Streaming progress (nested sub-agent/workflow events). Each call also
   *  resets the tool's idle timeout — long but chatty work is never cut off. */
  onEvent: (event: unknown) => void;
}

export interface AssistantTool extends ToolDeclaration {
  execution: "server" | "frontend";
  /** Server tools only. Must return the string handed to the model. */
  execute?: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** Per-run gate configuration, mirroring tool-gate.ts semantics. */
export interface ToolGateConfig {
  /** Agent allowlist (016). Empty ⇒ zero registry tools. */
  allow: Set<string>;
  /** Deferred set (025) — purely per-agent (`agent.deferredTools`); there is no
   *  registry-wide default. */
  deferred: Set<string>;
  /** Capability-registry ids — non-registry tools (surface tools, elicitations)
   *  always pass the allowlist, like today's gate. */
  registryIds: Set<string>;
  /** Description overrides (Settings → Tools). */
  descriptions: Record<string, string | undefined>;
}

const DISCOVERY_TOOLS = new Set(["find_tools", "find_agent"]);

/** The tools visible to the model on this step: allowlist + deferred-until-
 *  revealed + description overrides. Pure — called per step so tools revealed
 *  by the previous step become callable on the next. */
export function visibleTools(
  tools: Record<string, AssistantTool>,
  gate: ToolGateConfig,
  revealed: Set<string>,
): ToolDeclaration[] {
  const out: ToolDeclaration[] = [];
  for (const [name, t] of Object.entries(tools)) {
    if (!DISCOVERY_TOOLS.has(name) && gate.registryIds.has(name)) {
      if (!gate.allow.has(name)) continue;
      if (gate.deferred.has(name) && !revealed.has(name)) continue;
    }
    out.push({
      name,
      description: gate.descriptions[name] ?? t.description,
      parameters: t.parameters,
    });
  }
  return out;
}
