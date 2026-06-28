"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { parseToolArgs } from "@/lib/mcp/args";

// Lets the agent inspect/manage MCP server connections AND use their tools via the
// gateway (014-mcp-tool-gateway): the agent never gets every server's tools in
// context — it searches/lists tools (with schemas) and calls them on demand. The
// `agentId` (the chat's pinned agent) scopes the gateway to that agent's allowed
// servers (011); omitted = the globally active agent.
export function McpActions({ agentId }: { agentId?: string }) {
  const scope = agentId ? `&agent=${encodeURIComponent(agentId)}` : "";

  useCopilotAction({
    name: "listMcpServers",
    description: "List the MCP servers available to you, with their descriptions (what each is for).",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/mcp").then((r) => r.json());
      return JSON.stringify(res.servers ?? []);
    },
  });

  useCopilotAction({
    name: "findTools",
    description:
      "Search for MCP tools across all servers available to you. Use this to discover the right tool for a task (e.g. 'list repositories'). Query is a case-insensitive search over tool name + description; '*' and '?' wildcards are supported. Returns each tool's server, name, description, and input JSON schema. Then call it with callMcpServerTool.",
    parameters: [{ name: "query", type: "string", description: "Search text or wildcard pattern, e.g. 'repo*'", required: true }],
    handler: async ({ query }) => {
      const res = await fetch(`/api/mcp/tools?find=${encodeURIComponent(String(query ?? ""))}${scope}`).then((r) => r.json());
      return JSON.stringify(res);
    },
  });

  useCopilotAction({
    name: "listMcpServerTools",
    description:
      "List the tools a specific MCP server exposes, each with its description and input JSON schema, so you can call one with callMcpServerTool.",
    parameters: [{ name: "server", type: "string", description: "MCP server name", required: true }],
    handler: async ({ server }) => {
      const res = await fetch(`/api/mcp/tools?server=${encodeURIComponent(String(server ?? ""))}${scope}`).then((r) => r.json());
      return JSON.stringify(res);
    },
  });

  useCopilotAction({
    name: "callMcpServerTool",
    description:
      "Call a tool on an MCP server. Discover the server, tool name, and argument schema first via findTools or listMcpServerTools, then pass `args` as a JSON object STRING matching that schema.",
    parameters: [
      { name: "server", type: "string", description: "MCP server name", required: true },
      { name: "tool", type: "string", description: "Tool name on that server", required: true },
      {
        // MUST be a JSON string, not an object: a bare object parameter has no
        // declared properties, so the chat framework strips the model's keys to {}
        // before the call is made (see src/lib/mcp/args.ts).
        name: "args",
        type: "string",
        description:
          'Arguments as a JSON object string matching the tool\'s input schema, e.g. \'{"project_id":41,"issue_iid":3,"state_event":"close"}\'. Use \'{}\' if the tool takes none.',
        required: false,
      },
    ],
    handler: async ({ server, tool, args }) => {
      const parsed = parseToolArgs(args);
      if (parsed.error) return `Error: ${parsed.error}`;
      const res = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server, tool, args: parsed.args, agent: agentId }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : String(res.result ?? "");
    },
  });

  useCopilotAction({
    name: "addMcpServer",
    description:
      "Connect a new MCP server. For 'http' (streamable, default) or 'sse', give an endpoint URL (+ optional apiKey bearer token or custom headers). For 'stdio', give a command and args (e.g. command 'docker', args ['run','-i','--rm', …]) with optional env. Users can also manage these in Settings → MCP Servers.",
    parameters: [
      { name: "name", type: "string", description: "Unique friendly name (the key)", required: true },
      { name: "description", type: "string", description: "What the server is for (shown to you as an index)", required: false },
      { name: "transport", type: "string", description: '"http" (default), "sse", or "stdio"', required: false },
      { name: "endpoint", type: "string", description: "Server URL (http/sse)", required: false },
      { name: "apiKey", type: "string", description: "Bearer token (http/sse)", required: false },
      { name: "headers", type: "object", description: 'Custom headers (http/sse), e.g. { "Private-Token": "…" }', required: false },
      { name: "command", type: "string", description: "Executable to spawn (stdio), e.g. 'docker'", required: false },
      { name: "args", type: "string[]", description: "Command arguments (stdio)", required: false },
      { name: "env", type: "object", description: "Environment variables (stdio)", required: false },
    ],
    handler: async ({ name, description, transport, endpoint, apiKey, headers, command, args, env }) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, transport, endpoint, apiKey, headers, command, args, env }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Connected. Servers: ${JSON.stringify(res.servers)}`;
    },
  });

  useCopilotAction({
    name: "removeMcpServer",
    description: "Disconnect an MCP server by its name.",
    parameters: [{ name: "name", type: "string", description: "MCP server name", required: true }],
    handler: async ({ name }) => {
      const res = await fetch(`/api/mcp?name=${encodeURIComponent(name as string)}`, { method: "DELETE" }).then((r) => r.json());
      return `Remaining servers: ${JSON.stringify(res.servers ?? [])}`;
    },
  });

  return null;
}
