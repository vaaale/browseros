import "server-only";
import * as vfs from "@/os/vfs";

// Per-conversation review watermarks (spec 021 FR-006). Kept in a sidecar file
// the memory subsystem owns, NOT inside the client-owned conversation JSON, so
// the client can freely rewrite /Documents/Chats/<id>.json without racing us.
//
// Shape (JSON):
//   { [conversationId]: { messageId: string, reviewedAt: string } }
//
// The `messageId` is opaque to this module — the fast loop stores the id of the
// last reviewed assistant/user message. If the client can't guarantee ids, an
// index-as-string ("42") works too. Startup validation is best-effort: if a
// watermark points past the current message count for a conversation, the fast
// loop resets it lazily rather than at load.

const WATERMARKS_PATH = "/Documents/Memory/.watermarks.json";

export interface WatermarkEntry {
  messageId: string;
  reviewedAt: string;
}
type WatermarkMap = Record<string, WatermarkEntry>;

// Cache + write serialization: reads happen on every fast-loop tick per
// eligible conversation, and writes must not stomp concurrent updates.
let cache: WatermarkMap | null = null;
let saveChain: Promise<unknown> = Promise.resolve();

async function load(): Promise<WatermarkMap> {
  if (cache) return cache;
  try {
    const raw = await vfs.readText(WATERMARKS_PATH);
    const parsed = JSON.parse(raw) as WatermarkMap;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") cache = {};
    else throw err;
  }
  return cache;
}

async function save(map: WatermarkMap): Promise<void> {
  const run = saveChain.then(async () => {
    await vfs.writeText(WATERMARKS_PATH, JSON.stringify(map, null, 2));
  });
  saveChain = run.catch(() => undefined);
  await run;
}

/** Read the last-reviewed message id for a conversation (null if never reviewed). */
export async function getWatermark(conversationId: string): Promise<string | null> {
  const map = await load();
  return map[conversationId]?.messageId ?? null;
}

/** Read the full watermark record (messageId + timestamp) — used by eligibility
 *  checks that want to know whether we've seen a conversation at all. */
export async function getWatermarkEntry(conversationId: string): Promise<WatermarkEntry | null> {
  const map = await load();
  return map[conversationId] ?? null;
}

/** Advance the watermark to a new message id. Persisted atomically via VFS. */
export async function setWatermark(conversationId: string, messageId: string): Promise<void> {
  const map = { ...(await load()) };
  map[conversationId] = { messageId, reviewedAt: new Date().toISOString() };
  cache = map;
  await save(map);
}

/** Clear the watermark for a conversation (e.g. after a re-index or corrupted state). */
export async function resetWatermark(conversationId: string): Promise<void> {
  const map = { ...(await load()) };
  if (!(conversationId in map)) return;
  delete map[conversationId];
  cache = map;
  await save(map);
}

/** Read the whole watermark map — used by fast-loop scan + validation. */
export async function allWatermarks(): Promise<WatermarkMap> {
  return { ...(await load()) };
}

/** Testing / boot hook: forget the in-memory cache so the next read hits disk. */
export function invalidateWatermarkCache(): void {
  cache = null;
}
