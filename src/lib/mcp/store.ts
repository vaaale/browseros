import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { McpServerConfig } from "./types";

const FILE = path.join(process.cwd(), "data", "mcp-servers.json");

function fromEnv(): McpServerConfig[] {
  const raw = process.env.BOS_MCP_SERVERS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((endpoint, i) => ({ name: `server-${i + 1}`, endpoint, transport: "http" as const }));
}

/**
 * Configured MCP servers. The on-disk file is the source of truth once it
 * exists; otherwise we fall back to the BOS_MCP_SERVERS environment variable.
 */
export async function listMcpServers(): Promise<McpServerConfig[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as McpServerConfig[];
  } catch {
    return fromEnv();
  }
}

async function save(servers: McpServerConfig[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(servers, null, 2), "utf8");
}

export async function addMcpServer(cfg: McpServerConfig): Promise<McpServerConfig[]> {
  const servers = await listMcpServers();
  const next = [...servers.filter((s) => s.endpoint !== cfg.endpoint), cfg];
  await save(next);
  return next;
}

export async function removeMcpServer(endpoint: string): Promise<McpServerConfig[]> {
  const next = (await listMcpServers()).filter((s) => s.endpoint !== endpoint);
  await save(next);
  return next;
}
