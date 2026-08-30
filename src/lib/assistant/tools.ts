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
  /** Trigger an inline frontend-tool elicitation and await its result string.
   *  Use this when a server tool needs user input before it can proceed (e.g.
   *  branch selection). The elicitation card renders in the chat; on submit the
   *  tool resumes with the result. Also re-arms the tool's idle timeout so a
   *  user who takes time to respond does not trigger a spurious timeout. */
  elicit: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  /** Nested-delegation depth (025-agent-delegation-v2). 0 for the primary/
   *  top-level run; incremented by one for each inner-loop delegation. Used
   *  by agent_delegate/dev_delegate to enforce MAX_DELEGATE_DEPTH uniformly
   *  across named/ephemeral/surface delegation. */
  delegationDepth?: number;
  /** The owning run's id (025-agent-delegation-v2) — lets a server tool (e.g.
   *  agent_delegate) look up the actual `Run` via `runManager().get(runId)` to
   *  reuse its `tools`/`toolTimeoutMs`/`awaitFrontendResult` for an inner loop. */
  runId: string;
}

/** A server tool's result, when it needs to hand the model something beyond
 *  plain text — e.g. an image the tool just read/generated, so the model
 *  actually SEES it (a vision content block) rather than being told about it
 *  in prose. Most tools just return a string; this is the escape hatch for
 *  the few that need to attach visual content to their own result. */
export interface ToolExecuteResult {
  text: string;
  attachments?: import("./messages").Attachment[];
}

export interface AssistantTool extends ToolDeclaration {
  execution: "server" | "frontend";
  /** Server tools only. Must return the string handed to the model, or a
   *  ToolExecuteResult when the result needs attachments (e.g. an image). */
  execute?: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolExecuteResult>;
  /** Opt in to running concurrently with ADJACENT parallel-safe calls in the
   *  same turn (agent-loop.ts). Default false = strictly sequential, which is
   *  what every tool did before this existed.
   *
   *  Only set this when the tool is safe to run alongside a copy of itself and
   *  alongside its neighbours — in practice: no shared mutable state, no
   *  write to a path another call might touch, no single-slot external
   *  resource. Read-only lookups and fan-out delegations qualify; writes,
   *  and anything that lazily creates a shared singleton (e.g. the
   *  run_command sandbox container), do not. */
  parallelSafe?: boolean;
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
