import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { ensureTelegramDir, telegramDir } from "./paths";

// TTL-cached local copy of the user's contacts and chat list. Fetching the
// full list of chats over MTProto is expensive (Telegram serialises the whole
// dialog list); we cache the result so the UI can render immediately from
// disk and refresh in the background.
//
// Cache files:
//   data/integrations/telegram/contacts.json  — { entries, fetchedAt }
//   data/integrations/telegram/chats.json     — { entries, fetchedAt }
//
// TTL is 30 minutes by default; callers can force a refresh via `refresh: true`
// on the adapter method.

const DEFAULT_TTL_MS = 30 * 60_000;

export interface CachedContact {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  isBot?: boolean;
  status?: string; // e.g. "online", "recently", "lastSeen:<epoch>"
}

export interface CachedChat {
  id: string;
  type: "user" | "chat" | "channel" | "unknown";
  title?: string;
  username?: string;
  unreadCount?: number;
  lastMessage?: {
    text?: string;
    date?: number;
    fromId?: string;
  };
  pinned?: boolean;
  archived?: boolean;
  muted?: boolean;
}

interface Cache<T> {
  entries: T[];
  fetchedAt: number;
}

function contactsFile(): string {
  return path.join(telegramDir(), "contacts.json");
}
function chatsFile(): string {
  return path.join(telegramDir(), "chats.json");
}

async function readCache<T>(file: string): Promise<Cache<T> | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as Cache<T>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeCache<T>(file: string, data: Cache<T>): Promise<void> {
  await ensureTelegramDir();
  await writeFileAtomic(file, JSON.stringify(data, null, 0));
}

export function isFresh(cache: Cache<unknown> | null, ttlMs = DEFAULT_TTL_MS): boolean {
  if (!cache) return false;
  return Date.now() - cache.fetchedAt < ttlMs;
}

export async function readContactsCache(): Promise<Cache<CachedContact> | null> {
  return readCache<CachedContact>(contactsFile());
}

export async function writeContactsCache(entries: CachedContact[]): Promise<void> {
  await writeCache<CachedContact>(contactsFile(), { entries, fetchedAt: Date.now() });
}

export async function readChatsCache(): Promise<Cache<CachedChat> | null> {
  return readCache<CachedChat>(chatsFile());
}

export async function writeChatsCache(entries: CachedChat[]): Promise<void> {
  await writeCache<CachedChat>(chatsFile(), { entries, fetchedAt: Date.now() });
}

/**
 * Patch a single chat's cached state (e.g. after mute/archive/pin). Returns
 * the updated chat entry or null when the chat isn't in the cache.
 */
export async function updateCachedChat(
  chatId: string,
  patch: Partial<CachedChat>,
): Promise<CachedChat | null> {
  const cache = await readChatsCache();
  if (!cache) return null;
  const idx = cache.entries.findIndex((c) => c.id === chatId);
  if (idx < 0) return null;
  const updated: CachedChat = { ...cache.entries[idx], ...patch, id: chatId };
  const nextEntries = cache.entries.slice();
  nextEntries[idx] = updated;
  await writeCache<CachedChat>(chatsFile(), {
    entries: nextEntries,
    fetchedAt: cache.fetchedAt,
  });
  return updated;
}

export async function clearUserCaches(): Promise<void> {
  await Promise.all([
    fs.unlink(contactsFile()).catch(() => undefined),
    fs.unlink(chatsFile()).catch(() => undefined),
  ]);
}
