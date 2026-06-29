import "server-only";
import { runToolLoop, type ToolEvent, type LlmTool } from "@/lib/agent/llm";
import { toolsFor, DEV_TOOLS, SPEC_TOOLS, DELEGATE_TO_DEVELOPER } from "./tools";
import { runClaudeAgent } from "./claude-runner";
import { getAgent } from "./store";
import { stageAll } from "@/lib/system/git";
import type { Agent, AgentRunResult } from "./types";

export type SubAgentEvent = ToolEvent;

const DEV_TOOL_IDS = Object.keys(DEV_TOOLS);
const SPEC_TOOL_IDS = Object.keys(SPEC_TOOLS);
// A local agent wielding repo-scoped tools is doing multi-step dev work; give it
// a much larger step budget than the default chat tool loop. Build Studio (spec
// tools + delegation) likewise runs multi-step pipelines.
const DEV_MAX_STEPS = 40;
// Build Studio -> Developer is one level of nesting; guard against more.
const MAX_DELEGATE_DEPTH = 2;

/** The delegate_to_developer tool. Built per-run so it can forward the parent's
 *  event stream (for the nested-agent UI) and carry a depth guard. */
function makeDelegateTool(parentOnEvent: ((e: SubAgentEvent) => void) | undefined, depth: number): LlmTool {
  return {
    description:
      "Delegate an implementation/coding task to the Developer (Claude) sub-agent, which edits BOS source on a feature branch. Use this for `implement` — never write source yourself. Provide a complete task including the relevant spec/plan/tasks context and acceptance criteria.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "Full implementation task with context and acceptance criteria." } },
      required: ["task"],
    },
    execute: async (input) => {
      if (depth >= MAX_DELEGATE_DEPTH) return "Delegation depth limit reached; cannot nest another sub-agent.";
      const dev = await getAgent("developer");
      if (!dev) return "No 'developer' sub-agent is available to implement this.";
      const res = await runSubAgent(dev, String(input.task ?? ""), { onEvent: parentOnEvent, depth: depth + 1 });
      if (res.error) return `Developer error: ${res.error}`;
      return res.output || "(the developer returned no output)";
    },
  };
}

async function runLocal(
  agent: Agent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void; depth?: number },
): Promise<AgentRunResult> {
  const depth = opts?.depth ?? 0;
  const ids = agent.tools ?? [];
  const isDev = ids.some((id) => DEV_TOOL_IDS.includes(id));
  const isExtended = isDev || ids.includes(DELEGATE_TO_DEVELOPER) || ids.some((id) => SPEC_TOOL_IDS.includes(id));

  const tools = { ...toolsFor(agent.tools) };
  if (ids.includes(DELEGATE_TO_DEVELOPER)) {
    tools[DELEGATE_TO_DEVELOPER] = makeDelegateTool(opts?.onEvent, depth);
  }

  const result = await runToolLoop({
    system: agent.systemPrompt,
    prompt: task,
    tools,
    maxSteps: isExtended ? DEV_MAX_STEPS : undefined,
    onEvent: opts?.onEvent,
  });
  let output = result.text;
  if (isDev) {
    // Same deterministic staging backstop as the Claude harness: ensure files a
    // dev agent created are staged, not left untracked.
    try {
      const r = await stageAll();
      if (r.staged > 0) output += `\n\n[harness] Staged ${r.staged} changed file(s)${r.created ? ` (${r.created} new)` : ""}.`;
    } catch {
      /* ignore staging errors */
    }
  }
  return { agent: agent.name, type: "local", task, output, steps: result.steps, toolCalls: result.toolCalls };
}

/** Run a sub-agent. Claude agents run as Claude Code (headless CLI or MCP harness)
 *  so development is actually done by Claude; local agents run via the configured
 *  provider's tool loop. onEvent streams tool calls live as they happen. */
export async function runSubAgent(
  agent: Agent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void; contentOnly?: boolean; depth?: number },
): Promise<AgentRunResult> {
  if (agent.type === "claude") {
    // Development must be done by Claude — no local-provider fallback here.
    return runClaudeAgent(agent, task, opts);
  }
  try {
    return await runLocal(agent, task, opts);
  } catch (e) {
    return { agent: agent.name, type: "local", task, output: "", steps: 0, toolCalls: [], error: (e as Error).message };
  }
}
