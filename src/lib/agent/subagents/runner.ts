import "server-only";
import { runToolLoop, type ToolEvent } from "@/lib/agent/llm";
import { toolsFor, DEV_TOOLS } from "./tools";
import { runClaudeAgent } from "./claude-runner";
import { stageAll } from "@/lib/system/git";
import type { SubAgent, SubAgentRunResult } from "./types";

export type SubAgentEvent = ToolEvent;

const DEV_TOOL_IDS = Object.keys(DEV_TOOLS);
// A local agent wielding repo-scoped tools is doing multi-step dev work; give it
// a much larger step budget than the default chat tool loop.
const DEV_MAX_STEPS = 40;

async function runLocal(
  agent: SubAgent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void },
): Promise<SubAgentRunResult> {
  const isDev = (agent.tools ?? []).some((id) => DEV_TOOL_IDS.includes(id));
  const result = await runToolLoop({
    system: agent.systemPrompt,
    prompt: task,
    tools: toolsFor(agent.tools),
    maxSteps: isDev ? DEV_MAX_STEPS : undefined,
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
  agent: SubAgent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void; contentOnly?: boolean },
): Promise<SubAgentRunResult> {
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
