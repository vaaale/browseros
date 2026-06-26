import "server-only";
import { runToolLoop } from "@/lib/agent/llm";
import { toolsFor } from "./tools";
import { runClaudeAgent } from "./claude-runner";
import type { SubAgent, SubAgentRunResult } from "./types";

/** Run a sub-agent: Claude agents via the harness, local agents via the provider. */
export async function runSubAgent(agent: SubAgent, task: string): Promise<SubAgentRunResult> {
  if (agent.type === "claude") {
    return runClaudeAgent(agent, task);
  }
  try {
    const result = await runToolLoop({ system: agent.systemPrompt, prompt: task, tools: toolsFor(agent.tools) });
    return { agent: agent.name, type: "local", task, output: result.text, steps: result.steps, toolCalls: result.toolCalls };
  } catch (e) {
    return { agent: agent.name, type: "local", task, output: "", steps: 0, toolCalls: [], error: (e as Error).message };
  }
}
