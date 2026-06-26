import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import * as vfs from "@/os/vfs";
import { fetchText } from "@/lib/net";

export type ToolExecutor = (input: Record<string, unknown>) => Promise<string>;

interface ToolDef {
  schema: Anthropic.Tool;
  execute: ToolExecutor;
}

export const SUBAGENT_TOOLS: Record<string, ToolDef> = {
  list_files: {
    schema: {
      name: "list_files",
      description: "List entries in a virtual file system directory.",
      input_schema: { type: "object", properties: { path: { type: "string", description: 'Directory, defaults to "/"' } } },
    },
    execute: async (input) => JSON.stringify(await vfs.list((input.path as string) || "/")),
  },
  read_file: {
    schema: {
      name: "read_file",
      description: "Read a text file from the virtual file system.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    execute: async (input) => vfs.readText(input.path as string),
  },
  write_file: {
    schema: {
      name: "write_file",
      description: "Create or overwrite a text file in the virtual file system.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    execute: async (input) => {
      await vfs.writeText(input.path as string, (input.content as string) ?? "");
      return `Wrote ${input.path}`;
    },
  },
  create_folder: {
    schema: {
      name: "create_folder",
      description: "Create a directory in the virtual file system.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    execute: async (input) => {
      await vfs.mkdir(input.path as string);
      return `Created ${input.path}`;
    },
  },
  web_fetch: {
    schema: {
      name: "web_fetch",
      description: "Fetch a web page and return its readable text content.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    execute: async (input) => fetchText(input.url as string),
  },
};

export function toolSchemasFor(allowed?: string[]): Anthropic.Tool[] {
  const ids = allowed && allowed.length > 0 ? allowed : Object.keys(SUBAGENT_TOOLS);
  return ids.filter((id) => SUBAGENT_TOOLS[id]).map((id) => SUBAGENT_TOOLS[id].schema);
}
