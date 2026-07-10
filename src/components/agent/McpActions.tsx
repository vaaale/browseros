"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { parseToolArgs } from "@/lib/mcp/args";
import { fetchToolJson, runToolHandler } from "@/lib/agent/tool-kernel";

// Agent-facing MCP tool gateway (014-mcp-tool-gateway). The agent never gets every
// server's tools in context — it follows a staged discovery flow:
//   1. listMcpServers()              → pick the relevant server
//   2. searchMcpTools(server, query) → find the right tool
//   3. getMcpToolSchema(server, tool) → inspect the inputSchema
//   4. callMcpTool(server, tool, args) → execute with schema-matching arguments
// The `agentId` (the chat's pinned agent) scopes the gateway to that agent's allowed
// servers (011); omitted = the globally active agent.
//
// All handlers run inside runToolHandler (the tool kernel): they always settle
// and return an in-band `Error: …` string on failure so the run never hangs.
export function McpActions({ agentId }: { agentId?: string }) {
  const scope = agentId ? `&agent=${encodeURIComponent(agentId)}` : "";

  useCopilotAction({
    name: "mcp_server_list",
    description: "List the MCP servers available to you, with their descriptions (what each is for).",
    parameters: [],
    handler: () =>
      runToolHandler("mcp_server_list", async ({ signal }) => {
        const out = await fetchToolJson("mcp_server_list", "/api/mcp", { signal });
        if (!out.ok) return out.error;
        return JSON.stringify(out.data.servers ?? []);
      }),
  });

  useCopilotAction({
    name: "mcp_tool_search",
    description:
      "Search for MCP tools across all servers available to you, or on a specific server. Returns each tool's server, name, and description (not full schemas). Use getMcpToolSchema to inspect the inputSchema before calling.",
    parameters: [
      { name: "query", type: "string", description: "Search text or wildcard pattern, e.g. 'repo*' or 'create issue'", required: true },
      { name: "server", type: "string", description: "Optional: restrict search to this MCP server only", required: false },
    ],
    handler: ({ query, server }) =>
      runToolHandler("mcp_tool_search", async ({ signal }) => {
        if (server) {
          const out = await fetchToolJson("mcp_tool_search", `/api/mcp/tools?server=${encodeURIComponent(String(server))}${scope}`, { signal });
          if (!out.ok) return out.error;
          const match = String(query ?? "").toLowerCase();
          const tools = ((out.data.tools ?? []) as { name: string; description?: string }[]).filter(
            (t) => t.name.toLowerCase().includes(match) || (t.description ?? "").toLowerCase().includes(match),
          );
          return JSON.stringify({ tools });
        }
        const out = await fetchToolJson("mcp_tool_search", `/api/mcp/tools?find=${encodeURIComponent(String(query ?? ""))}${scope}`, { signal });
        if (!out.ok) return out.error;
        return JSON.stringify(out.data);
      }),
  });

  useCopilotAction({
    name: "mcp_server_tools",
    description:
      "List all tools a specific MCP server exposes, each with its description and input JSON schema.",
    parameters: [{ name: "server", type: "string", description: "MCP server name", required: true }],
    handler: ({ server }) =>
      runToolHandler("mcp_server_tools", async ({ signal }) => {
        const out = await fetchToolJson("mcp_server_tools", `/api/mcp/tools?server=${encodeURIComponent(String(server ?? ""))}${scope}`, { signal });
        if (!out.ok) return out.error;
        return JSON.stringify(out.data);
      }),
  });

  useCopilotAction({
    name: "mcp_tool_schema",
    description:
      "Get the full input JSON schema for a single MCP tool, so you know exactly what arguments to pass to callMcpTool.",
    parameters: [
      { name: "server", type: "string", description: "MCP server name", required: true },
      { name: "tool", type: "string", description: "Tool name on that server", required: true },
    ],
    handler: ({ server, tool }) =>
      runToolHandler("mcp_tool_schema", async ({ signal }) => {
        const out = await fetchToolJson(
          "mcp_tool_schema",
          `/api/mcp/tools?server=${encodeURIComponent(String(server ?? ""))}&tool=${encodeURIComponent(String(tool ?? ""))}${scope}`,
          { signal },
        );
        if (!out.ok) return out.error;
        return JSON.stringify(out.data);
      }),
  });

  useCopilotAction({
    name: "mcp_tool_call",
    description:
      "Call a tool on an MCP server. Discover the server, tool name, and argument schema first via searchMcpTools + getMcpToolSchema, then pass `args` as a JSON object string matching that schema. The proxy validates arguments against the tool's inputSchema before forwarding.",
    parameters: [
      { name: "server", type: "string", description: "MCP server name", required: true },
      { name: "tool", type: "string", description: "Tool name on that server", required: true },
      {
        // MUST be a JSON string, not an object: CopilotKit converts an object-typed
        // action parameter with no declared sub-properties into a closed schema
        // (no additionalProperties), so the model's keys get stripped to {} before
        // the call reaches the handler. A string passes through untouched.
        name: "args",
        type: "string",
        description:
          'Arguments as a JSON object string matching the tool\'s input schema, e.g. \'{"project_id":41,"title":"Fix login bug"}\'. Use \'{}\' if the tool takes none.',
        required: false,
      },
    ],
    handler: ({ server, tool, args }) =>
      runToolHandler("mcp_tool_call", async ({ signal }) => {
        const parsed = parseToolArgs(args);
        if (parsed.error) return `Error: ${parsed.error}`;
        const out = await fetchToolJson("mcp_tool_call", "/api/mcp/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ server, tool, arguments: parsed.args, agent: agentId }),
          signal,
        });
        if (!out.ok) return out.error;
        return out.data.error ? `Error: ${out.data.error}` : String(out.data.result ?? "");
      }),
  });

  useCopilotAction({
    name: "mcp_server_add",
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
    handler: ({ name, description, transport, endpoint, apiKey, headers, command, args, env }) =>
      runToolHandler("mcp_server_add", async ({ signal }) => {
        const out = await fetchToolJson("mcp_server_add", "/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, transport, endpoint, apiKey, headers, command, args, env }),
          signal,
        });
        if (!out.ok) return out.error;
        return out.data.error ? `Error: ${out.data.error}` : `Connected. Servers: ${JSON.stringify(out.data.servers)}`;
      }),
  });

  useCopilotAction({
    name: "mcp_server_remove",
    description: "Disconnect an MCP server by its name.",
    parameters: [{ name: "name", type: "string", description: "MCP server name", required: true }],
    handler: ({ name }) =>
      runToolHandler("mcp_server_remove", async ({ signal }) => {
        const out = await fetchToolJson("mcp_server_remove", `/api/mcp?name=${encodeURIComponent(name as string)}`, {
          method: "DELETE",
          signal,
        });
        if (!out.ok) return out.error;
        return `Remaining servers: ${JSON.stringify(out.data.servers ?? [])}`;
      }),
  });

  return null;
}
