import "server-only";
import * as vfs from "@/os/vfs";
import { agentWatermarksFile } from "./paths";

// Per-agent, per-conversation review watermarks (023-per-agent-memory, spec 021
// FR-006). Stored at /Memories/<agentId>/.watermarks.json — a sidecar the memory
// subsystem owns, NOT inside the client-owned conversation JSON, so the client
// can freely rewrite /Documents/Chats/<id>.json without racing us.
//
// Shape (JSON): { [conversationId]: { messageId: string, reviewedAt: string } }

export interface WatermarkEntry {
  messageId: string;
  reviewedAt: string;
}
type WatermarkMap = Record<string, WatermarkEntry>;

// Cache + write serialization, keyed per agent.
const caches = new Map<string, WatermarkMap>();
const saveChains = new Map<string, Promise<unknown>>();

async function load(agentId: string): Promise<WatermarkMap> {
  const cached = caches.get(agentId);
  if (cached) return cached;
  let map: WatermarkMap = {};
  try {
    const raw = await vfs.readText(agentWatermarksFile(agentId));
    const parsed = JSON.parse(raw) as WatermarkMap;
    map = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  caches.set(agentId, map);
  return map;
}

async function save(agentId: string, map: WatermarkMap): Promise<void> {
  const prev = saveChains.get(agentId) ?? Promise.resolve();
  const run = prev.then(async () => {
    await vfs.writeText(agentWatermarksFile(agentId), JSON.stringify(map, null, 2));
  });
  saveChains.set(agentId, run.catch(() => undefined));
  await run;
}

/** Read the full watermark record for a conversation (null if never reviewed). */
export async function getWatermarkEntry(agentId: string, conversationId: string): Promise<WatermarkEntry | null> {
  const map = await load(agentId);
  return map[conversationId] ?? null;
}

/** Advance the watermark to a new message id. */
export async function setWatermark(agentId: string, conversationId: string, messageId: string): Promise<void> {
  const map = { ...(await load(agentId)) };
  map[conversationId] = { messageId, reviewedAt: new Date().toISOString() };
  caches.set(agentId, map);
  await save(agentId, map);
}

/** Clear the watermark for a conversation. */
export async function resetWatermark(agentId: string, conversationId: string): Promise<void> {
  const map = { ...(await load(agentId)) };
  if (!(conversationId in map)) return;
  delete map[conversationId];
  caches.set(agentId, map);
  await save(agentId, map);
}

/** Testing / boot hook: forget the in-memory cache so the next read hits disk. */
export function invalidateWatermarkCache(): void {
  caches.clear();
}
