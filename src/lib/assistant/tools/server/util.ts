import "server-only";
import type { AssistantTool, ToolContext, ToolExecuteResult } from "../../tools";

// Shared helpers for the server tool modules (Milestone C ports of the
// *Actions.tsx fetch-wrappers). Every tool built through `serverTool` gets the
// kernel guarantee the old client runToolHandler provided: execute() never
// throws — failures become in-band `Error: <tool>: …` strings for the model.

type Execute = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolExecuteResult>;

function isToolExecuteResult(v: unknown): v is ToolExecuteResult {
  return !!v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string";
}

/** Build a server AssistantTool whose executor can never throw. */
export function serverTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: Execute,
): AssistantTool {
  return {
    name,
    description,
    parameters,
    execution: "server",
    execute: async (input, ctx) => {
      try {
        const out = await execute(input ?? {}, ctx);
        if (typeof out === "string") return out;
        if (isToolExecuteResult(out)) return out;
        return JSON.stringify(out);
      } catch (e) {
        return `Error: ${name}: ${(e as Error).message}`;
      }
    },
  };
}

/**
 * Mark a tool safe to run concurrently with adjacent parallel-safe calls
 * (agent-loop.ts's batching). Wrap a `serverTool(...)` in it:
 *
 *     web_search: parallel(serverTool("web_search", …)),
 *
 * Only wrap a tool that is safe alongside a copy of ITSELF and alongside its
 * neighbours: read-only lookups, and fan-outs whose state is per-call. Do NOT
 * wrap writers, or anything that lazily creates a shared singleton — the
 * run_command sandbox container is the live example (its ensureContainer would
 * race two concurrent creates), which is why the markitdown/ffmpeg-backed tools
 * are deliberately left sequential.
 */
export function parallel(tool: AssistantTool): AssistantTool {
  return { ...tool, parallelSafe: true };
}

/** JSON-Schema `{ type: "object", … }` wrapper for a tool's parameters. */
export function schema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required };
}

/** Property shorthands mirroring the CopilotKit parameter types. */
export const p = {
  str: (description: string) => ({ type: "string", description }),
  num: (description: string) => ({ type: "number", description }),
  bool: (description: string) => ({ type: "boolean", description }),
  strArr: (description: string) => ({ type: "array", items: { type: "string" }, description }),
  obj: (description: string) => ({ type: "object", description }),
};
