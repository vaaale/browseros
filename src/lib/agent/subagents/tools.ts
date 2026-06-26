import "server-only";
import * as vfs from "@/os/vfs";
import { fetchText } from "@/lib/net";
import type { LlmTool } from "@/lib/agent/llm";

// Provider-neutral tools (JSON Schema params) available to sub-agents.
export const SUBAGENT_TOOLS: Record<string, LlmTool> = {
  list_files: {
    description: "List entries in a virtual file system directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: 'Directory, defaults to "/"' } } },
    execute: async (input) => JSON.stringify(await vfs.list((input.path as string) || "/")),
  },
  read_file: {
    description: "Read a text file from the virtual file system.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => vfs.readText(input.path as string),
  },
  write_file: {
    description: "Create or overwrite a text file in the virtual file system.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: async (input) => {
      await vfs.writeText(input.path as string, (input.content as string) ?? "");
      return `Wrote ${input.path}`;
    },
  },
  create_folder: {
    description: "Create a directory in the virtual file system.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input) => {
      await vfs.mkdir(input.path as string);
      return `Created ${input.path}`;
    },
  },
  web_fetch: {
    description: "Fetch a web page and return its readable text content.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    execute: async (input) => fetchText(input.url as string),
  },
};

export function toolsFor(allowed?: string[]): Record<string, LlmTool> {
  if (!allowed || allowed.length === 0) return SUBAGENT_TOOLS;
  return Object.fromEntries(allowed.filter((id) => SUBAGENT_TOOLS[id]).map((id) => [id, SUBAGENT_TOOLS[id]]));
}
