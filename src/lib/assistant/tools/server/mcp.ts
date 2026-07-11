import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { listMcpServers, addMcpServer, removeMcpServer } from "@/lib/mcp/store";
import { findTools, listServerTools, getToolSchema, callServerTool } from "@/lib/mcp/gateway";
import { parseToolArgs } from "@/lib/mcp/args";
import type { McpServerConfig } from "@/lib/mcp/types";

// Agent-facing MCP tool gateway (014-mcp-tool-gateway), ported from
// McpActions.tsx. Staged discovery flow: list servers → search tools → inspect
// schema → call. The run's agent id scopes the gateway to that agent's allowed
// servers (011).

// Build a valid McpServerConfig from tool input, validating per transport
// (mirrors /api/mcp's normalizeConfig). Throws on invalid input.
function normalizeConfig(body: Partial<McpServerConfig>): McpServerConfig {
  const transport: McpServerConfig["transport"] =
    body.transport === "sse" ? "sse" : body.transport === "stdio" ? "stdio" : "http";

  const description = body.description?.trim() || undefined;

  if (transport === "stdio") {
    const command = body.command?.trim() || (body.endpoint ?? "").trim().split(/\s+/)[0];
    if (!command) throw new Error('stdio transport requires a command (e.g. "docker" or "npx")');
    const name = body.name?.trim() || command;
    return {
      name,
      description,
      transport,
      command: body.command?.trim() || undefined,
      args: Array.isArray(body.args) ? body.args.filter((a) => typeof a === "string") : undefined,
      env: body.env && typeof body.env === "object" ? body.env : undefined,
      cwd: body.cwd?.trim() || undefined,
      endpoint: body.endpoint?.trim() || undefined,
    };
  }

  if (!body.endpoint) throw new Error("http/sse transport requires an endpoint URL");
  const url = new URL(body.endpoint); // validates the URL
  const name = body.name?.trim() || url.host;
  return {
    name,
    description,
    transport,
    endpoint: body.endpoint,
    apiKey: body.apiKey || undefined,
    headers: body.headers && typeof body.headers === "object" ? body.headers : undefined,
  };
}

export function mcpTools(): Record<string, AssistantTool> {
  return {
    mcp_server_list: serverTool(
      "mcp_server_list",
      "List the MCP servers available to you, with their descriptions (what each is for).",
      schema(),
      async () => JSON.stringify(await listMcpServers()),
    ),

    mcp_tool_search: serverTool(
      "mcp_tool_search",
      "Search for MCP tools across all servers available to you, or on a specific server. Returns each tool's server, name, and description (not full schemas). Use getMcpToolSchema to inspect the inputSchema before calling.",
      schema(
        {
          query: p.str("Search text or wildcard pattern, e.g. 'repo*' or 'create issue'"),
          server: p.str("Optional: restrict search to this MCP server only"),
        },
        ["query"],
      ),
      async (input, ctx) => {
        const query = String(input.query ?? "");
        const server = typeof input.server === "string" && input.server ? input.server : undefined;
        if (server) {
          const res = await listServerTools(server, ctx.agentId);
          if (res.error) return `Error: ${res.error}`;
          const match = query.toLowerCase();
          const tools = (res.tools ?? []).filter(
            (t) => t.name.toLowerCase().includes(match) || (t.description ?? "").toLowerCase().includes(match),
          );
          return JSON.stringify({ tools });
        }
        return JSON.stringify(await findTools(query, ctx.agentId));
      },
    ),

    mcp_server_tools: serverTool(
      "mcp_server_tools",
      "List all tools a specific MCP server exposes, each with its description and input JSON schema.",
      schema({ server: p.str("MCP server name") }, ["server"]),
      async (input, ctx) => JSON.stringify(await listServerTools(String(input.server ?? ""), ctx.agentId)),
    ),

    mcp_tool_schema: serverTool(
      "mcp_tool_schema",
      "Get the full input JSON schema for a single MCP tool, so you know exactly what arguments to pass to callMcpTool.",
      schema(
        {
          server: p.str("MCP server name"),
          tool: p.str("Tool name on that server"),
        },
        ["server", "tool"],
      ),
      async (input, ctx) =>
        JSON.stringify(await getToolSchema(String(input.server ?? ""), String(input.tool ?? ""), ctx.agentId)),
    ),

    mcp_tool_call: serverTool(
      "mcp_tool_call",
      "Call a tool on an MCP server. Discover the server, tool name, and argument schema first via searchMcpTools + getMcpToolSchema, then pass `args` as a JSON object string matching that schema. The proxy validates arguments against the tool's inputSchema before forwarding.",
      schema(
        {
          server: p.str("MCP server name"),
          tool: p.str("Tool name on that server"),
          // MUST be a JSON string, not an object: an object-typed parameter with
          // no declared sub-properties gets closed down by some providers, so
          // the model's keys are stripped to {}. A string passes untouched.
          args: p.str(
            'Arguments as a JSON object string matching the tool\'s input schema, e.g. \'{"project_id":41,"title":"Fix login bug"}\'. Use \'{}\' if the tool takes none.',
          ),
        },
        ["server", "tool"],
      ),
      async (input, ctx) => {
        const parsed = parseToolArgs(input.args);
        if (parsed.error) return `Error: ${parsed.error}`;
        const out = await callServerTool(
          String(input.server ?? ""),
          String(input.tool ?? ""),
          parsed.args ?? {},
          ctx.agentId,
        );
        return out.error ? `Error: ${out.error}` : String(out.result ?? "");
      },
    ),

    mcp_server_add: serverTool(
      "mcp_server_add",
      "Connect a new MCP server. For 'http' (streamable, default) or 'sse', give an endpoint URL (+ optional apiKey bearer token or custom headers). For 'stdio', give a command and args (e.g. command 'docker', args ['run','-i','--rm', …]) with optional env. Users can also manage these in Settings → MCP Servers.",
      schema(
        {
          name: p.str("Unique friendly name (the key)"),
          description: p.str("What the server is for (shown to you as an index)"),
          transport: p.str('"http" (default), "sse", or "stdio"'),
          endpoint: p.str("Server URL (http/sse)"),
          apiKey: p.str("Bearer token (http/sse)"),
          headers: p.obj('Custom headers (http/sse), e.g. { "Private-Token": "…" }'),
          command: p.str("Executable to spawn (stdio), e.g. 'docker'"),
          args: p.strArr("Command arguments (stdio)"),
          env: p.obj("Environment variables (stdio)"),
        },
        ["name"],
      ),
      async (input) => {
        const cfg = normalizeConfig(input as Partial<McpServerConfig>);
        const servers = await addMcpServer(cfg);
        return `Connected. Servers: ${JSON.stringify(servers)}`;
      },
    ),

    mcp_server_remove: serverTool(
      "mcp_server_remove",
      "Disconnect an MCP server by its name.",
      schema({ name: p.str("MCP server name") }, ["name"]),
      async (input) => {
        const name = String(input.name ?? "");
        if (!name) return "Error: mcp_server_remove: name is required — pass the server name from mcp_server_list.";
        const servers = await removeMcpServer(name);
        return `Remaining servers: ${JSON.stringify(servers ?? [])}`;
      },
    ),
  };
}
