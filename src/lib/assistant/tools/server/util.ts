import "server-only";
import type { AssistantTool, ToolContext } from "../../tools";

// Shared helpers for the server tool modules (Milestone C ports of the
// *Actions.tsx fetch-wrappers). Every tool built through `serverTool` gets the
// kernel guarantee the old client runToolHandler provided: execute() never
// throws — failures become in-band `Error: <tool>: …` strings for the model.

type Execute = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

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
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (e) {
        return `Error: ${name}: ${(e as Error).message}`;
      }
    },
  };
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
