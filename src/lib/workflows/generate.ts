import "server-only";
import { complete } from "@/lib/agent/llm";
import { listSubAgents } from "@/lib/agent/subagents/store";
import type { SubAgent } from "@/lib/agent/subagents/types";
import { generateWorkflowId } from "./store";
import type { Workflow } from "./types";

const SYSTEM = `You are a workflow planner for BrowserOS. Given a task description and the list of available sub-agents, output a SINGLE JSON object describing the workflow.

Schema:
{
  "id": string,            // short slug; if omitted the server assigns one
  "name": string,
  "version": 1,
  "config": { "maxConcurrentSteps": 5, "defaultRetryLimit": 3, "defaultTimeout": 300 },
  "agents": [ { "id": string, "type": "claude"|"local", "description": string } ],
  "steps": [
    {
      "id": string,
      "type": "delegate"|"tool"|"ag-ui",
      "agentId": string,                 // required for delegate/tool
      "toolName": string,                // required for tool
      "input": object,
      "outputConvention": string,        // e.g. "write_to_file: /Workflows/results/<step>-output.txt"
      "dependencies": string[],
      "retryLimit": number,
      "timeout": number
    }
  ],
  "ui": { "type": "ag-ui", "spec": "dynamic", "description": "..." }
}

Hard rules:
- Use ONLY agents from the provided list. The workflow "agents" array must reuse the exact ids you saw.
- Steps form a DAG. Express data flow via "dependencies".
- Use type "delegate" for open-ended work, "tool" for a single tool invocation, "ag-ui" to emit a UI state update.
- Outputs go in /Workflows/results/. Set outputConvention accordingly.
- Return ONLY the JSON in a fenced \`\`\`json block.`;

function buildAgentList(agents: SubAgent[]): string {
  return agents
    .map((a) => `- ${a.id} (${a.type}) — ${a.description || "no description"}`)
    .join("\n");
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  // Fallback: first {...} block.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** Generate a workflow JSON from a natural-language task description. */
export async function generateWorkflowFromTask(
  task: string,
  availableAgents?: SubAgent[],
): Promise<Workflow> {
  const agents = availableAgents ?? (await listSubAgents());
  const prompt = `Task:\n${task}\n\nAvailable sub-agents:\n${buildAgentList(agents)}\n\nReturn the workflow JSON now.`;
  const raw = await complete({ system: SYSTEM, prompt });
  let parsed: Partial<Workflow>;
  try {
    parsed = JSON.parse(extractJson(raw)) as Partial<Workflow>;
  } catch (err) {
    throw new Error(`Failed to parse workflow JSON from model output: ${(err as Error).message}`);
  }
  const name = String(parsed.name || "Untitled Workflow");
  const wf: Workflow = {
    id: String(parsed.id || generateWorkflowId(name)),
    name,
    version: parsed.version ?? 1,
    config: parsed.config ?? { maxConcurrentSteps: 5, defaultRetryLimit: 3, defaultTimeout: 300 },
    agents: Array.isArray(parsed.agents) ? parsed.agents : [],
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    ui: parsed.ui ?? { type: "ag-ui", spec: "dynamic", description: "Live workflow execution" },
  };
  return wf;
}
