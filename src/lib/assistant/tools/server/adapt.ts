import "server-only";
import type { AssistantTool } from "../../tools";
import type { LlmTool } from "@/lib/agent/llm";

// Adapt the server-side sub-agent LlmTool implementations (src/lib/agent/
// subagents/tools.ts) into v2 AssistantTools. These are the SAME operations the
// delegated Developer/Build Studio agents already use, so the main chat and
// sub-agents share one implementation. LlmTool.execute takes only `input`; the
// AssistantTool ctx is unused here (these ops need no signal/onEvent).
export function adaptLlmTools(
  tools: Record<string, LlmTool>,
  ids: string[],
): Record<string, AssistantTool> {
  const out: Record<string, AssistantTool> = {};
  for (const id of ids) {
    const t = tools[id];
    if (!t) continue;
    out[id] = {
      name: id,
      description: t.description ?? "",
      parameters: t.parameters,
      execution: "server",
      execute: async (input) => {
        try {
          const result = await t.execute(input ?? {});
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch (e) {
          return `Error: ${id}: ${(e as Error).message}`;
        }
      },
    };
  }
  return out;
}
