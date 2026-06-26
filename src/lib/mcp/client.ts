import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, McpProbeResult } from "./types";
import { encodeMcpUi } from "./ui";

// CopilotKit's expected MCP client shape (see @copilotkit/runtime mcp-tools-utils).
interface CopilotMcpTool {
  description?: string;
  schema?: { parameters?: { properties?: Record<string, unknown>; required?: string[]; jsonSchema?: Record<string, unknown> } };
  execute(params: unknown): Promise<unknown>;
}
export interface CopilotMcpClient {
  tools(): Promise<Record<string, CopilotMcpTool>>;
  close?(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 8000;
// Spawning a stdio server (e.g. `claude mcp serve`) can take longer to boot.
const STDIO_CONNECT_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function stdioTransport(cfg: McpServerConfig): Transport {
  const parts = cfg.endpoint.trim().split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (!command) throw new Error("stdio transport requires a command (e.g. \"claude mcp serve\")");
  return new StdioClientTransport({
    command,
    args: parts.slice(1),
    cwd: cfg.cwd || process.cwd(),
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
  });
}

export async function connectMcpClient(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: "browseros", version: "0.1.0" }, { capabilities: {} });
  let transport: Transport;
  let timeout = CONNECT_TIMEOUT_MS;
  if (cfg.transport === "stdio") {
    transport = stdioTransport(cfg);
    timeout = STDIO_CONNECT_TIMEOUT_MS;
  } else {
    const url = new URL(cfg.endpoint);
    const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined;
    transport =
      cfg.transport === "sse"
        ? new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined })
        : new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined });
  }
  await withTimeout(client.connect(transport), timeout, `MCP connect to ${cfg.endpoint}`);
  return client;
}

interface ContentItem {
  type: string;
  text?: string;
  resource?: { uri?: string; mimeType?: string; text?: string };
}

export function extractText(result: unknown): string {
  const r = result as { content?: ContentItem[]; structuredContent?: unknown };
  if (Array.isArray(r?.content)) {
    // MCP-UI: surface an interactive HTML resource for iframe rendering.
    for (const item of r.content) {
      if (item?.type === "resource" && item.resource) {
        const { uri = "", mimeType = "", text } = item.resource;
        if (mimeType.includes("html") || uri.startsWith("ui://")) {
          if (text) return encodeMcpUi({ html: text });
          if (uri.startsWith("http")) return encodeMcpUi({ url: uri });
        }
      }
    }
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (text) return text;
  }
  if (r?.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  return JSON.stringify(result);
}

/**
 * Build a CopilotKit-compatible MCP client. Resilient by design: if the server
 * is unreachable, returns a client that simply exposes no tools so the agent
 * keeps working instead of failing the whole chat request.
 */
export async function createBosMcpClient(cfg: McpServerConfig): Promise<CopilotMcpClient> {
  let client: Client;
  try {
    client = await connectMcpClient(cfg);
  } catch (err) {
    console.warn(`[BOS][MCP] ${cfg.endpoint} unavailable: ${(err as Error).message}`);
    return { async tools() { return {}; } };
  }

  return {
    async tools() {
      try {
        const { tools } = await client.listTools();
        const map: Record<string, CopilotMcpTool> = {};
        for (const t of tools) {
          const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
          map[t.name] = {
            description: t.description,
            schema: { parameters: { properties: schema?.properties, required: schema?.required, jsonSchema: t.inputSchema as Record<string, unknown> } },
            execute: async (params: unknown) => {
              // Generous timeout: harness tools like Claude Code's "Agent" run
              // autonomously for a while; reset the clock on progress pings.
              const res = await client.callTool(
                { name: t.name, arguments: (params as Record<string, unknown>) ?? {} },
                undefined,
                { timeout: 280_000, resetTimeoutOnProgress: true },
              );
              return extractText(res);
            },
          };
        }
        return map;
      } catch (err) {
        console.warn(`[BOS][MCP] listTools failed for ${cfg.endpoint}: ${(err as Error).message}`);
        return {};
      }
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Connectivity check used by the management API and dev studio. */
export async function probeMcpServer(cfg: McpServerConfig): Promise<McpProbeResult> {
  let client: Client;
  try {
    client = await connectMcpClient(cfg);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    const { tools } = await client.listTools();
    return { ok: true, tools: tools.map((t) => t.name) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await client.close().catch(() => {});
  }
}
