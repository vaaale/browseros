import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureTelegramDir, telegramDir } from "./paths";

// Local full-text search index over Telegram messages fetched via MTProto.
//
// Storage:
//   data/integrations/telegram/messages.json   — raw message store (append-only, JSON)
//   data/integrations/telegram/index.json      — flexsearch's serialised index
//
// Design notes:
// - We use `flexsearch` (pure JS, no native compile) so the integration can
//   ship without needing better-sqlite3's C toolchain. Users with very large
//   message archives can swap this out later; the interface is intentionally
//   narrow (indexMessages / searchMessages / removeChat).
// - The index is rebuilt from the raw store on first access — this keeps
//   the "on-disk index" cheap to bootstrap and means an index-format change
//   in a future flexsearch upgrade doesn't strand cached data.
// - The message store is chat-partitioned so a single very active chat can be
//   pruned independently of the rest. Each partition is capped at 20k messages
//   so an idle sync loop doesn't grow forever.

const MAX_PER_CHAT = 20_000;

export interface IndexedMessage {
  /** Composite id `<chatId>:<messageId>` — flexsearch requires string ids. */
  id: string;
  /** Numeric Telegram chat id (positive for DMs, negative for groups). */
  chatId: string;
  /** Numeric Telegram message id (unique within the chat). */
  messageId: number;
  /** Sender user id (for group chats). */
  senderId?: string;
  /** Message body — text or caption. */
  text: string;
  /** Epoch seconds (Telegram uses seconds). */
  date: number;
  /** Optional media summary (mime, filename, etc.). Not indexed for FTS. */
  media?: string;
}

export interface SearchFilters {
  /** Restrict results to a single chat. */
  chatId?: string;
  /** Restrict by sender. */
  senderId?: string;
  /** Epoch seconds — only messages at/after this time. */
  since?: number;
  /** Epoch seconds — only messages at/before this time. */
  until?: number;
  /** Max results (default 50, capped at 500). */
  limit?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedIndex: any | null = null;
let cachedMessages: Map<string, IndexedMessage> | null = null;

function messagesFile(): string {
  return path.join(telegramDir(), "messages.json");
}

async function readMessages(): Promise<Map<string, IndexedMessage>> {
  if (cachedMessages) return cachedMessages;
  try {
    const raw = await fs.readFile(messagesFile(), "utf8");
    const parsed = JSON.parse(raw) as { entries?: IndexedMessage[] };
    const map = new Map<string, IndexedMessage>();
    for (const m of parsed.entries ?? []) map.set(m.id, m);
    cachedMessages = map;
    return map;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const map = new Map<string, IndexedMessage>();
    cachedMessages = map;
    return map;
  }
}

async function writeMessages(map: Map<string, IndexedMessage>): Promise<void> {
  await ensureTelegramDir();
  const entries = [...map.values()];
  await writeFileAtomic(messagesFile(), JSON.stringify({ entries }, null, 0));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadFlexsearch(): Promise<any> {
  try {
    return await import("flexsearch");
  } catch (err) {
    throw new Error(
      `flexsearch package not installed. Run 'npm install flexsearch' to enable Telegram message search. Original: ${(err as Error).message}`,
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getIndex(): Promise<any> {
  if (cachedIndex) return cachedIndex;
  const flex = await loadFlexsearch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DocumentCtor: any = flex.Document ?? flex.default?.Document;
  if (!DocumentCtor) {
    throw new Error("flexsearch loaded but Document constructor missing.");
  }
  cachedIndex = new DocumentCtor({
    document: {
      id: "id",
      index: [
        { field: "text", tokenize: "forward" },
      ],
      store: ["chatId", "messageId", "senderId", "date", "text"],
    },
    tokenize: "forward",
    optimize: true,
    cache: 100,
  });
  // Warm the index with any persisted messages.
  const map = await readMessages();
  for (const m of map.values()) {
    try {
      cachedIndex.add(m);
    } catch {
      // Skip malformed entries — they'll be rebuilt on next indexMessages call.
    }
  }
  return cachedIndex;
}

/**
 * Add or update a batch of messages. Both the persisted store and the live
 * index are updated. Duplicate ids (same chat + same message id) are
 * treated as updates.
 */
export async function indexMessages(messages: IndexedMessage[]): Promise<{ added: number }> {
  if (messages.length === 0) return { added: 0 };
  const idx = await getIndex();
  const store = await readMessages();
  const byChat = new Map<string, IndexedMessage[]>();
  let added = 0;
  for (const m of messages) {
    const existing = store.get(m.id);
    if (existing) {
      idx.update(m);
    } else {
      idx.add(m);
      added++;
    }
    store.set(m.id, m);
    const bucket = byChat.get(m.chatId) ?? [];
    bucket.push(m);
    byChat.set(m.chatId, bucket);
  }
  // Enforce per-chat cap: drop oldest messages beyond MAX_PER_CHAT.
  for (const [chatId, chatMsgs] of byChat.entries()) {
    const all = [...store.values()].filter((m) => m.chatId === chatId);
    if (all.length <= MAX_PER_CHAT) continue;
    all.sort((a, b) => a.date - b.date);
    const excess = all.length - MAX_PER_CHAT;
    for (const drop of all.slice(0, excess)) {
      store.delete(drop.id);
      try {
        idx.remove(drop.id);
      } catch {
        /* flexsearch may throw on missing ids — safe to ignore */
      }
    }
    // chatMsgs is unused after logging; kept for future observability hooks.
    void chatMsgs;
  }
  await writeMessages(store);
  return { added };
}

/**
 * Full-text search across the local message archive. Free-form `query` is
 * matched against message text; optional filters narrow the result set.
 */
export async function searchMessages(
  query: string,
  filters: SearchFilters = {},
): Promise<IndexedMessage[]> {
  const idx = await getIndex();
  const store = await readMessages();
  const limit = Math.max(1, Math.min(500, filters.limit ?? 50));
  const raw = idx.search(query, { limit: limit * 4, enrich: false });
  // flexsearch returns either an array of ids OR an array of { field, result }.
  const ids = new Set<string>();
  const flat: unknown[] = Array.isArray(raw) ? raw : [];
  for (const entry of flat) {
    if (typeof entry === "string" || typeof entry === "number") {
      ids.add(String(entry));
    } else if (entry && typeof entry === "object" && "result" in entry) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (entry as any).result;
      if (Array.isArray(arr)) {
        for (const r of arr) {
          if (typeof r === "string" || typeof r === "number") ids.add(String(r));
          else if (r && typeof r === "object" && "id" in r) ids.add(String((r as { id: unknown }).id));
        }
      }
    }
  }
  const out: IndexedMessage[] = [];
  for (const id of ids) {
    const msg = store.get(id);
    if (!msg) continue;
    if (filters.chatId && msg.chatId !== filters.chatId) continue;
    if (filters.senderId && msg.senderId !== filters.senderId) continue;
    if (filters.since != null && msg.date < filters.since) continue;
    if (filters.until != null && msg.date > filters.until) continue;
    out.push(msg);
    if (out.length >= limit) break;
  }
  // Newest first — the LLM and UI both prefer recent results.
  out.sort((a, b) => b.date - a.date);
  return out;
}

/** Wipe every indexed message for a given chat (e.g. after chat was left). */
export async function removeChat(chatId: string): Promise<{ removed: number }> {
  const idx = await getIndex();
  const store = await readMessages();
  let removed = 0;
  for (const [id, msg] of store) {
    if (msg.chatId === chatId) {
      store.delete(id);
      try {
        idx.remove(id);
      } catch {
        /* ok */
      }
      removed++;
    }
  }
  if (removed > 0) await writeMessages(store);
  return { removed };
}

/** Wipe the entire index — used on user-service disconnect. */
export async function clearIndex(): Promise<void> {
  cachedIndex = null;
  cachedMessages = new Map();
  await writeMessages(cachedMessages);
}

/** Snapshot for the settings UI (message count, last indexed timestamp). */
export async function indexStats(): Promise<{ messageCount: number; lastMessageAt?: number }> {
  const store = await readMessages();
  let last = 0;
  for (const m of store.values()) {
    if (m.date > last) last = m.date;
  }
  return {
    messageCount: store.size,
    lastMessageAt: last > 0 ? last : undefined,
  };
}
