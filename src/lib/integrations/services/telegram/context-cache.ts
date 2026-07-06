import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { integrationsRoot } from "../../paths";

// Per-chat rolling context store for the Telegram agent-routing feature.
//
// Layout:
//   data/integrations/telegram/context/<botId>/<chatId>.json
//   { chatId, messages: [{ role, content, timestamp }], updatedAt }
//
// botId is the bot's numeric Telegram id (from getMe.id) — that lets several
// bots share the framework without their conversation contexts colliding.
// chatId is the numeric chat id from the Update payload.
//
// Retention:
//   - Each chat file keeps at most MAX_MESSAGES_PER_CHAT recent turns.
//   - A background LRU sweep bounds the number of chat files per bot at
//     MAX_CHATS_PER_BOT — oldest updatedAt evicted first. The sweep runs on
//     write (cheap: single fs.readdir + stat pass), so the cache stays bounded
//     without a separate daemon.

const MAX_MESSAGES_PER_CHAT = 20;
const MAX_CHATS_PER_BOT = 100;

export type ContextRole = "user" | "assistant";

export interface ContextMessage {
  role: ContextRole;
  content: string;
  /** Unix ms — used for display and eviction ordering. */
  timestamp: number;
}

interface ChatContextFile {
  chatId: string;
  messages: ContextMessage[];
  updatedAt: number;
}

function contextRoot(): string {
  return path.join(integrationsRoot(), "telegram", "context");
}

function botDir(botId: string): string {
  return path.join(contextRoot(), botId);
}

function chatFile(botId: string, chatId: string): string {
  return path.join(botDir(botId), `${chatId}.json`);
}

// One mutex per (botId, chatId) so concurrent updates from webhook + long-poll
// don't clobber each other. Framework guarantees at-most-once dispatch per
// update, but a bot that receives from both channels during a config change
// window could otherwise race here.
const locks = new Map<string, Promise<void>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  locks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

async function readChatFile(botId: string, chatId: string): Promise<ChatContextFile | null> {
  try {
    const raw = await fs.readFile(chatFile(botId, chatId), "utf8");
    const parsed = JSON.parse(raw) as Partial<ChatContextFile>;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      chatId: String(parsed.chatId ?? chatId),
      messages: parsed.messages.filter(
        (m): m is ContextMessage =>
          !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
      ),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeChatFile(botId: string, file: ChatContextFile): Promise<void> {
  await fs.mkdir(botDir(botId), { recursive: true });
  await writeFileAtomic(chatFile(botId, file.chatId), JSON.stringify(file, null, 2));
}

/**
 * LRU sweep: if the bot's directory exceeds MAX_CHATS_PER_BOT files, delete
 * the oldest by updatedAt. Silent on failures — an eviction miss just means
 * we hold slightly more state than the cap; nothing incorrect happens.
 */
async function evictIfNeeded(botId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(botDir(botId));
  } catch {
    return;
  }
  const jsonFiles = entries.filter((n) => n.endsWith(".json"));
  if (jsonFiles.length <= MAX_CHATS_PER_BOT) return;
  const stats = await Promise.all(
    jsonFiles.map(async (name) => {
      try {
        const st = await fs.stat(path.join(botDir(botId), name));
        return { name, mtimeMs: st.mtimeMs };
      } catch {
        return { name, mtimeMs: 0 };
      }
    }),
  );
  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const surplus = stats.length - MAX_CHATS_PER_BOT;
  for (const s of stats.slice(0, surplus)) {
    await fs.unlink(path.join(botDir(botId), s.name)).catch(() => {});
  }
}

/**
 * Return the last `depth` (default MAX_MESSAGES_PER_CHAT) messages for the
 * given chat, oldest-first (ready to be spliced into an LLM prompt).
 */
export async function readContext(
  botId: string,
  chatId: string,
  depth = MAX_MESSAGES_PER_CHAT,
): Promise<ContextMessage[]> {
  const file = await readChatFile(botId, chatId);
  if (!file) return [];
  if (depth >= file.messages.length) return file.messages;
  return file.messages.slice(-depth);
}

/**
 * Append one turn (user or assistant) to the chat's context and persist. The
 * store keeps only the most recent MAX_MESSAGES_PER_CHAT turns; older ones are
 * dropped from the head of the array.
 */
export async function appendMessage(
  botId: string,
  chatId: string,
  message: ContextMessage,
): Promise<void> {
  await withLock(`${botId}:${chatId}`, async () => {
    const existing = (await readChatFile(botId, chatId)) ?? {
      chatId,
      messages: [],
      updatedAt: message.timestamp,
    };
    const next: ChatContextFile = {
      chatId,
      messages: [...existing.messages, message].slice(-MAX_MESSAGES_PER_CHAT),
      updatedAt: message.timestamp,
    };
    await writeChatFile(botId, next);
    // Best-effort LRU pass. Errors are swallowed inside evictIfNeeded so a
    // partial sweep never fails the write path.
    await evictIfNeeded(botId).catch(() => {});
  });
}

/** Wipe a single chat's context — used by the "reset conversation" UI action. */
export async function clearChatContext(botId: string, chatId: string): Promise<void> {
  await fs.unlink(chatFile(botId, chatId)).catch(() => {});
}

/** Wipe every chat context for a bot — used when the bot is disconnected. */
export async function clearBotContext(botId: string): Promise<void> {
  await fs.rm(botDir(botId), { recursive: true, force: true }).catch(() => {});
}
