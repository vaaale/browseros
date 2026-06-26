import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL } from "@/lib/agent/config";
import { SUBAGENT_TOOLS, toolSchemasFor } from "./tools";
import type { SubAgent, SubAgentRunResult } from "./types";

const MAX_STEPS = 8;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  return (client ??= new Anthropic());
}

/** Run a sub-agent as a bounded tool-use loop and return its final answer. */
export async function runSubAgent(agent: SubAgent, task: string): Promise<SubAgentRunResult> {
  const tools = toolSchemasFor(agent.tools);
  const toolCalls: { tool: string; input: unknown }[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let steps = 0;

  try {
    for (; steps < MAX_STEPS; steps++) {
      const res = await anthropic().messages.create({
        model: AGENT_MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: agent.systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
        tools,
      });

      if (res.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== "tool_use") continue;
          const def = SUBAGENT_TOOLS[block.name];
          let out: string;
          try {
            out = def ? await def.execute(block.input as Record<string, unknown>) : `Unknown tool: ${block.name}`;
          } catch (e) {
            out = `Error: ${(e as Error).message}`;
          }
          toolCalls.push({ tool: block.name, input: block.input });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: out });
        }
        messages.push({ role: "assistant", content: res.content });
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const output = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { agent: agent.name, task, output, steps: steps + 1, toolCalls };
    }
    return { agent: agent.name, task, output: "Reached the step limit before finishing.", steps, toolCalls };
  } catch (e) {
    return { agent: agent.name, task, output: "", steps, toolCalls, error: (e as Error).message };
  }
}
