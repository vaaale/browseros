import "server-only";
import { connectMcpClient, extractText } from "./client";
import { listMcpServers } from "./store";
import { makeToolMatcher } from "./match";
import { validateToolArguments } from "./validate";
import { isAllowed } from "@/lib/agent/capabilities";
import { getActiveAgentId, getAgent } from "@/lib/agent/subagents/store";
import type { McpServerConfig, McpToolDescriptor } from "./types";

type ArgumentAdapter = (args: Record<string, unknown>) => Record<string, unknown>;

const argumentAdapters: Record<string, ArgumentAdapter> = {};

function applyAdapter(server: string, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const adapter = argumentAdapters[`${server}.${tool}`];
  return adapter ? adapter(args) : args;
}

// The MCP tool gateway (014-mcp-tool-gateway). Instead of dumping every server's
// tools into the agent's context, the agent gets a tiny fixed tool set that
// discovers tools (find/list, WITH schemas) and calls them on demand. All entry
// points enforce the active agent's MCP server allowlist (011).

const CACHE_TTL_MS = 60_000;
const toolCache = new Map<string, { at: number; tools: McpToolDescriptor[] }>();

// The servers the given agent may use (unset/empty allowlist = all). Matches by
// name or endpoint so legacy endpoint-based allowlists keep working.
async function allowedServers(agentId?: string): Promise<McpServerConfig[]> {
  const agent = await getAgent(agentId ?? (await getActiveAgentId()));
  const allow = agent?.mcp;
  const all = await listMcpServers();
  return all.filter((s) => isAllowed(allow, s.name, s.endpoint ?? ""));
}

// Tools for one server, with a short-TTL cache so repeated find/list/call within a
// window don't reconnect each time. Resilient: a bad server returns an error, not a throw.
async function toolsForServer(cfg: McpServerConfig): Promise<{ tools?: McpToolDescriptor[]; error?: string }> {
  const hit = toolCache.get(cfg.name);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { tools: hit.tools };
  let client;
  try {
    client = await connectMcpClient(cfg);
  } catch (err) {
    return { error: (err as Error).message };
  }
  try {
    const { tools } = await client.listTools();
    const descs: McpToolDescriptor[] = tools.map((t) => ({
      server: cfg.name,
      name: t.name,
      description: t.description,
      schema: t.inputSchema,
    }));
    toolCache.set(cfg.name, { at: Date.now(), tools: descs });
    return { tools: descs };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    await client.close().catch(() => {});
  }
}

/** List a single server's tools (with schemas), enforcing the agent's allowlist. */
export async function listServerTools(
  server: string,
  agentId?: string,
): Promise<{ tools?: McpToolDescriptor[]; error?: string }> {
  const cfg = (await allowedServers(agentId)).find((s) => s.name === server);
  if (!cfg) return { error: `No MCP server "${server}" available to this agent.` };
  return toolsForServer(cfg);
}

/** Search tools across all of the agent's allowed servers. */
export async function findTools(
  query: string,
  agentId?: string,
): Promise<{ tools: McpToolDescriptor[]; errors?: Record<string, string> }> {
  const servers = await allowedServers(agentId);
  const match = makeToolMatcher(query);
  const tools: McpToolDescriptor[] = [];
  const errors: Record<string, string> = {};
  for (const s of servers) {
    const res = await toolsForServer(s);
    if (res.tools) tools.push(...res.tools.filter(match));
    else if (res.error) errors[s.name] = res.error;
  }
  return Object.keys(errors).length ? { tools, errors } : { tools };
}

/** Get the inputSchema for a single tool on a server. */
export async function getToolSchema(
  server: string,
  tool: string,
  agentId?: string,
): Promise<{ schema?: unknown; error?: string }> {
  const res = await listServerTools(server, agentId);
  if (res.error) return { error: res.error };
  const found = res.tools?.find((t) => t.name === tool);
  if (!found) return { error: `Tool '${tool}' not found on MCP server '${server}'` };
  return { schema: found.schema };
}

/** Execute a tool on a server, enforcing the agent's allowlist.
 *  `args` must be a JSON object matching the tool's MCP inputSchema.
 *  The proxy validates against the schema and forwards unchanged (after any
 *  registered per-tool adapter). */
export async function callServerTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  agentId?: string,
): Promise<{ result?: string; error?: string }> {
  const cfg = (await allowedServers(agentId)).find((s) => s.name === server);
  if (!cfg) return { error: `No MCP server "${server}" available to this agent.` };

  const toolArgs = args ?? {};

  let client;
  try {
    client = await connectMcpClient(cfg);
  } catch (err) {
    return { error: (err as Error).message };
  }
  try {
    const { tools } = await client.listTools();
    const toolDef = tools.find((t) => t.name === tool);
    if (!toolDef) {
      return { error: `Tool '${tool}' not found on MCP server '${server}'` };
    }

    const validation = validateToolArguments(server, tool, toolDef.inputSchema, toolArgs);
    if (!validation.valid) {
      return { error: `Invalid arguments for ${server}.${tool}: ${validation.error}` };
    }

    const adaptedArgs = applyAdapter(server, tool, toolArgs);

    const res = await client.callTool(
      { name: tool, arguments: adaptedArgs },
      undefined,
      { timeout: 280_000, resetTimeoutOnProgress: true },
    );
    return { result: extractText(res) };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    await client.close().catch(() => {});
  }
}
