import "server-only";
import { createBosMcpClient } from "@/lib/mcp/client";
import { getHarnessConfig } from "@/lib/devharness/harness-config";
import type { SubAgent, SubAgentRunResult } from "./types";

// Runs a Claude sub-agent via the Claude Code MCP harness (the Agent tool).
// The harness subagent_type is GENERATED from the sub-agent (its explicit
// subagentType, else its id) — never a single hardcoded config value.
export async function runClaudeAgent(
  agent: SubAgent,
  task: string,
  opts?: { onEvent?: (e: { tool: string; input: unknown }) => void },
): Promise<SubAgentRunResult> {
  const subagentType = agent.subagentType || agent.id;
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[] };
  // The harness Agent runs opaquely; emit one event so the UI shows activity.
  opts?.onEvent?.({ tool: `Claude:${subagentType}`, input: { task } });
  const { url } = await getHarnessConfig();
  const client = await createBosMcpClient({ name: "claude-agent", endpoint: url });
  try {
    const tools = await client.tools();
    const agentTool = tools["Agent"];
    if (!agentTool) {
      return { ...base, output: "", error: "The dev harness exposes no 'Agent' tool." };
    }
    const prompt = `${agent.systemPrompt}\n\n## Task\n${task}`;
    const out = await agentTool.execute({
      description: `BrowserOS: ${agent.name}`,
      prompt,
      subagent_type: subagentType,
    });
    return {
      ...base,
      output: typeof out === "string" ? out : JSON.stringify(out),
      steps: 1,
      toolCalls: [{ tool: "Agent", input: { subagent_type: subagentType } }],
    };
  } catch (e) {
    return { ...base, output: "", error: (e as Error).message };
  } finally {
    await client.close?.().catch(() => {});
  }
}
