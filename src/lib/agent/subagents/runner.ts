import "server-only";
import { runToolLoop, type ToolEvent } from "@/lib/agent/llm";
import { toolsFor } from "./tools";
import { runClaudeAgent } from "./claude-runner";
import type { SubAgent, SubAgentRunResult } from "./types";

export type SubAgentEvent = ToolEvent;

/** Run a sub-agent: Claude agents via the harness, local agents via the provider.
 *  onEvent streams tool calls live as they happen (local agents). */
export async function runSubAgent(
  agent: SubAgent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void },
): Promise<SubAgentRunResult> {
  if (agent.type === "claude") {
    return runClaudeAgent(agent, task, opts);
  }
  try {
    const result = await runToolLoop({
      system: agent.systemPrompt,
      prompt: task,
      tools: toolsFor(agent.tools),
      onEvent: opts?.onEvent,
    });
    return { agent: agent.name, type: "local", task, output: result.text, steps: result.steps, toolCalls: result.toolCalls };
  } catch (e) {
    return { agent: agent.name, type: "local", task, output: "", steps: 0, toolCalls: [], error: (e as Error).message };
  }
}
