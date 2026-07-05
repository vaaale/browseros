import "server-only";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { looksLikeInjection, firstInjectionMatch } from "./injection";
import { getMemoryLoopsConfig } from "./config";

// Topic-sharded long-term memory (spec 021 FR-012).
//
// A topic is a bullet-list of timestamped entries backed by
// /Documents/Memory/Topics/<slug>.md. The slow loop is the only writer at
// runtime and MUST go through the incremental add/replace/remove helpers here
// (never a raw file write) — this is the ACE anti-collapse rule from the spec.
//
// The file format is intentionally simple markdown so a user can inspect a
// topic in the Files app without a viewer:
//
//   # <slug>
//
//   > <one-line digest>
//
//   - [<yyyy-mm-dd>] <entry text>
//   - [<yyyy-mm-dd>] <entry text>
//   ...

const LOG = "memory.topics";
export const TOPICS_DIR = "/Documents/Memory/Topics";

export interface TopicEntry {
  /** Stable id — first ~8 chars of the entry text hash, or a short user-visible token. */
  id: string;
  /** Entry text as it appears on disk (leading dash and timestamp are re-added on serialize). */
  text: string;
  /** ISO date the entry was added or last superseded. */
  timestamp: string;
  /** If true, the entry text carries an inline "superseded YYYY-MM-DD" marker. */
  superseded?: boolean;
}

export interface Topic {
  slug: string;
  digest: string;
  entries: TopicEntry[];
  path: string;
}

// ── Path / slug helpers ──────────────────────────────────────────────────

function normalizeSlug(slug: string): string {
  const s = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`Invalid topic slug: "${slug}"`);
  return s;
}

export function topicPath(slug: string): string {
  return `${TOPICS_DIR}/${normalizeSlug(slug)}.md`;
}

// ── Parse / serialize ────────────────────────────────────────────────────

function hashId(text: string): string {
  // Deterministic short id: FNV-1a 32-bit → 8 hex chars. Good enough for
  // per-file entry addressing; collisions inside a single topic are impossible
  // in practice because add/replace ensure uniqueness at write time.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const ENTRY_LINE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.*)$/;

function parseTopic(slug: string, raw: string, path: string): Topic {
  const lines = raw.split(/\r?\n/);
  let digest = "";
  const entries: TopicEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("> ")) {
      if (!digest) digest = line.slice(2).trim();
      continue;
    }
    const m = ENTRY_LINE.exec(line);
    if (m) {
      const text = m[2].trim();
      entries.push({
        id: hashId(text),
        text,
        timestamp: m[1],
        superseded: /\(superseded\s+\d{4}-\d{2}-\d{2}\)/i.test(text),
      });
    }
  }
  return { slug, digest, entries, path };
}

function serializeTopic(topic: Topic): string {
  const lines: string[] = [];
  lines.push(`# ${topic.slug}`);
  lines.push("");
  if (topic.digest.trim()) {
    lines.push(`> ${topic.digest.trim()}`);
    lines.push("");
  }
  for (const e of topic.entries) {
    lines.push(`- [${e.timestamp}] ${e.text}`);
  }
  return lines.join("\n") + "\n";
}

function currentBudget(topic: Topic): number {
  return serializeTopic(topic).length;
}

function dayStamp(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── VFS helpers + per-topic serialization ────────────────────────────────

async function ensureDir(): Promise<void> {
  await vfs.mkdir(TOPICS_DIR);
}

async function readTopicFile(slug: string): Promise<Topic | null> {
  const path = topicPath(slug);
  try {
    const raw = await vfs.readText(path);
    return parseTopic(normalizeSlug(slug), raw, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeTopicFile(topic: Topic): Promise<void> {
  await ensureDir();
  await vfs.writeText(topic.path, serializeTopic(topic));
}

const locks = new Map<string, Promise<unknown>>();
function withTopicLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeSlug(slug);
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface TopicOpResult {
  success: boolean;
  message?: string;
  error?: string;
  usage?: string;
  entryId?: string;
}

function usageStr(topic: Topic, budget: number): string {
  const c = currentBudget(topic);
  const pct = budget > 0 ? Math.min(100, Math.round((c / budget) * 100)) : 0;
  return `${pct}% — ${c.toLocaleString()}/${budget.toLocaleString()} chars`;
}

/** List all topic slugs currently on disk. Cheap: one VFS list. */
export async function listTopicSlugs(): Promise<string[]> {
  try {
    const entries = await vfs.list(TOPICS_DIR);
    return entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .map((e) => e.name.replace(/\.md$/, ""));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Read a topic (returns null if it doesn't exist). Cheap read; no lock. */
export async function getTopic(slug: string): Promise<Topic | null> {
  return readTopicFile(slug);
}

/** Return a topic, creating an empty one on disk if missing. */
export async function getOrCreateTopic(slug: string, digest: string = ""): Promise<Topic> {
  const s = normalizeSlug(slug);
  return withTopicLock(s, async () => {
    const existing = await readTopicFile(s);
    if (existing) return existing;
    const topic: Topic = { slug: s, digest: digest.trim(), entries: [], path: topicPath(s) };
    await writeTopicFile(topic);
    logger().info(LOG, "topic created", { slug: s });
    return topic;
  });
}

/** Create a new topic (fails if it already exists). Returns the topic. Used by
 *  the slow loop's `topic_create` tool. */
export async function createTopic(slug: string, digest: string = ""): Promise<TopicOpResult & { topic?: Topic }> {
  const s = normalizeSlug(slug);
  return withTopicLock(s, async () => {
    if (await readTopicFile(s)) return { success: false, error: `Topic "${s}" already exists.` };
    if (looksLikeInjection(digest)) {
      logger().warn(LOG, "topic digest refused", { slug: s, pattern: firstInjectionMatch(digest) });
      return { success: false, error: "Refused: digest matched a prompt-injection pattern." };
    }
    const topic: Topic = { slug: s, digest: digest.trim(), entries: [], path: topicPath(s) };
    await writeTopicFile(topic);
    logger().info(LOG, "topic created", { slug: s });
    return { success: true, message: `Topic "${s}" created.`, topic };
  });
}

/** Append an entry to a topic. Enforces the per-topic character budget from
 *  the memoryLoops config — rejects the whole op when full (the caller can
 *  supersede an old entry or create a `<slug>-2` shard). */
export async function addTopicEntry(slug: string, content: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const text = content.trim();
  if (!text) return { success: false, error: "content is required." };
  if (looksLikeInjection(text)) {
    logger().warn(LOG, "entry refused — injection", { slug: s, pattern: firstInjectionMatch(text) });
    return { success: false, error: "Refused: entry matched a prompt-injection pattern." };
  }
  const { topicBudget } = await getMemoryLoopsConfig();
  return withTopicLock(s, async () => {
    const topic = (await readTopicFile(s)) ?? {
      slug: s,
      digest: "",
      entries: [],
      path: topicPath(s),
    };
    if (topic.entries.some((e) => e.text === text)) {
      return { success: true, message: "Entry already present; no change.", usage: usageStr(topic, topicBudget) };
    }
    const entry: TopicEntry = { id: hashId(text), text, timestamp: dayStamp() };
    const next: Topic = { ...topic, entries: [...topic.entries, entry] };
    if (currentBudget(next) > topicBudget) {
      return {
        success: false,
        error: `Over budget (${currentBudget(next).toLocaleString()}/${topicBudget.toLocaleString()} chars). Remove/replace entries or create a "${s}-2" shard.`,
        usage: usageStr(topic, topicBudget),
      };
    }
    await writeTopicFile(next);
    return { success: true, message: "Entry added.", entryId: entry.id, usage: usageStr(next, topicBudget) };
  });
}

/** Supersede an entry: replace its text with `newContent` (marked with a
 *  timestamped "(superseded …)" note in the old entry's history is out of
 *  scope — the slow loop passes the fully-formed replacement text). */
export async function replaceTopicEntry(
  slug: string,
  entryIdOrSubstring: string,
  newContent: string,
): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const text = newContent.trim();
  if (!text) return { success: false, error: "newContent is required (use remove_entry to delete)." };
  if (looksLikeInjection(text)) {
    logger().warn(LOG, "replace refused — injection", { slug: s, pattern: firstInjectionMatch(text) });
    return { success: false, error: "Refused: entry matched a prompt-injection pattern." };
  }
  const { topicBudget } = await getMemoryLoopsConfig();
  return withTopicLock(s, async () => {
    const topic = await readTopicFile(s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    const idx = findEntryIndex(topic, entryIdOrSubstring);
    if (idx < 0) return { success: false, error: `No matching entry for "${entryIdOrSubstring}".` };
    const next = { ...topic, entries: topic.entries.slice() };
    next.entries[idx] = { id: hashId(text), text, timestamp: dayStamp() };
    if (currentBudget(next) > topicBudget) {
      return {
        success: false,
        error: `Over budget after replace (${currentBudget(next).toLocaleString()}/${topicBudget.toLocaleString()}). Shorten the replacement.`,
        usage: usageStr(topic, topicBudget),
      };
    }
    await writeTopicFile(next);
    return { success: true, message: "Entry replaced.", entryId: next.entries[idx].id, usage: usageStr(next, topicBudget) };
  });
}

/** Remove an entry from a topic. */
export async function removeTopicEntry(slug: string, entryIdOrSubstring: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const { topicBudget } = await getMemoryLoopsConfig();
  return withTopicLock(s, async () => {
    const topic = await readTopicFile(s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    const idx = findEntryIndex(topic, entryIdOrSubstring);
    if (idx < 0) return { success: false, error: `No matching entry for "${entryIdOrSubstring}".` };
    const next = { ...topic, entries: topic.entries.slice() };
    next.entries.splice(idx, 1);
    await writeTopicFile(next);
    return { success: true, message: "Entry removed.", usage: usageStr(next, topicBudget) };
  });
}

function findEntryIndex(topic: Topic, entryIdOrSubstring: string): number {
  const needle = entryIdOrSubstring.trim();
  if (!needle) return -1;
  const byId = topic.entries.findIndex((e) => e.id === needle);
  if (byId >= 0) return byId;
  // Fallback: unique substring match on entry text.
  const matches = topic.entries
    .map((e, i) => (e.text.includes(needle) ? i : -1))
    .filter((i) => i >= 0);
  if (matches.length !== 1) return -1;
  return matches[0];
}
