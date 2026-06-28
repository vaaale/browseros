import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { McpServerConfig } from "./types";

const FILE = path.join(dataDir(), "mcp-servers.json");

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
  await writeFileAtomic(FILE, JSON.stringify(servers, null, 2));
}

export async function addMcpServer(cfg: McpServerConfig): Promise<McpServerConfig[]> {
  const servers = await listMcpServers();
  // Keyed by name (upsert): re-adding the same name replaces it.
  const next = [...servers.filter((s) => s.name !== cfg.name), cfg];
  await save(next);
  return next;
}

export async function removeMcpServer(name: string): Promise<McpServerConfig[]> {
  const next = (await listMcpServers()).filter((s) => s.name !== name);
  await save(next);
  return next;
}
