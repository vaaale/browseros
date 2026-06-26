import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig, McpProbeResult } from "./types";

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function connect(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: "browseros", version: "0.1.0" }, { capabilities: {} });
  const url = new URL(cfg.endpoint);
  const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined;
  const transport =
    cfg.transport === "sse"
      ? new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined })
      : new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined });
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect to ${cfg.endpoint}`);
  return client;
}

function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  if (Array.isArray(r?.content)) {
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
    client = await connect(cfg);
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
              const res = await client.callTool({ name: t.name, arguments: (params as Record<string, unknown>) ?? {} });
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
    client = await connect(cfg);
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
