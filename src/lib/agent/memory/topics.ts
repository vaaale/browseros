import "server-only";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { looksLikeInjection, firstInjectionMatch } from "./injection";
import { getMemoryLoopsConfig } from "./config";
import { agentTopicsDir } from "./paths";
import { rebuildMemoryIndex } from "./agent-memory";

// Per-agent topic-sharded long-term memory (023-per-agent-memory, spec 021
// FR-012; soft budget + lifecycle added by 028-memory-curation-retrieval). A
// topic is a bullet-list of timestamped entries backed by
// /Memories/<agentId>/Topics/<slug>.md. The slow loop is the only writer at
// runtime and MUST go through the incremental add/replace/remove helpers here
// (never a raw file write) — this is the ACE anti-collapse rule from the spec.
//
// Every create/modify/remove rebuilds the agent's MEMORY.md "# Memory index"
// so the index (slug -> digest) can never drift from what's on disk.
//
// File format (so a user can read a topic in the Files app without a viewer):
//
//   # <slug>
//
//   > <one-line digest>
//   <!-- needs-consolidation -->                              (present only when flagged)
//   - [<yyyy-mm-dd>] <entry text>
//   - [<yyyy-mm-dd>] <entry text> ⟦superseded by=<entryId>@<yyyy-mm-dd>⟧

const LOG = "memory.topics";

export interface TopicEntry {
  id: string;
  text: string;
  timestamp: string;
  /** Lifecycle state (028-memory-curation-retrieval). Absent/undefined ⇒ active. */
  state?: "active" | "superseded";
  /** Present only when state === "superseded": a reference to the entry that superseded this one. */
  supersededBy?: { id: string; timestamp: string };
}

export interface Topic {
  slug: string;
  digest: string;
  entries: TopicEntry[];
  path: string;
  /** Soft-budget flag: set on overflow, cleared only after a successful consolidation pass. */
  consolidate?: boolean;
}

// ── Path / slug helpers ──────────────────────────────────────────────────

function normalizeSlug(slug: string): string {
  const s = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error(`Invalid topic slug: "${slug}"`);
  return s;
}

export function topicPath(agentId: string, slug: string): string {
  return `${agentTopicsDir(agentId)}/${normalizeSlug(slug)}.md`;
}

// ── Parse / serialize ────────────────────────────────────────────────────

function hashId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const ENTRY_LINE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.*)$/;
// Inline lifecycle tag (ADR-5): "⟦superseded by=<entryId>@<timestamp>⟧" trailing an entry line.
const SUPERSEDE_TAG = /\s*⟦superseded by=([^@⟧]+)@([^⟧]+)⟧\s*$/;
// Legacy (pre-tag) heuristic, kept as a READ-TIME fallback for files written before
// the explicit tag existed. The explicit tag is authoritative when present.
const LEGACY_SUPERSEDED_RE = /\(superseded\s+\d{4}-\d{2}-\d{2}\)/i;
const CONSOLIDATE_MARKER = "<!-- needs-consolidation -->";

/** Parse one entry line's date + remainder into a TopicEntry. The id is a
 *  content hash of the CLEAN text — the lifecycle tag is stripped BEFORE
 *  hashing, so tagging/untagging an entry never changes its id (S4). */
function parseEntryLine(dateStr: string, rest: string): TopicEntry {
  const tagMatch = SUPERSEDE_TAG.exec(rest);
  if (tagMatch) {
    const text = rest.slice(0, tagMatch.index).trim();
    return {
      id: hashId(text),
      text,
      timestamp: dateStr,
      state: "superseded",
      supersededBy: { id: tagMatch[1].trim(), timestamp: tagMatch[2].trim() },
    };
  }
  const text = rest.trim();
  return {
    id: hashId(text),
    text,
    timestamp: dateStr,
    state: LEGACY_SUPERSEDED_RE.test(text) ? "superseded" : "active",
  };
}

function serializeEntryLine(e: TopicEntry): string {
  const tag = e.state === "superseded" && e.supersededBy ? ` ⟦superseded by=${e.supersededBy.id}@${e.supersededBy.timestamp}⟧` : "";
  return `- [${e.timestamp}] ${e.text}${tag}`;
}

function parseTopic(slug: string, raw: string, path: string): Topic {
  const lines = raw.split(/\r?\n/);
  let digest = "";
  let consolidate = false;
  const entries: TopicEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("> ")) {
      if (!digest) digest = line.slice(2).trim();
      continue;
    }
    if (line.trim() === CONSOLIDATE_MARKER) {
      consolidate = true;
      continue;
    }
    const m = ENTRY_LINE.exec(line);
    if (m) {
      entries.push(parseEntryLine(m[1], m[2]));
    }
  }
  return { slug, digest, entries, path, consolidate: consolidate || undefined };
}

function serializeTopic(topic: Topic): string {
  const lines: string[] = [];
  lines.push(`# ${topic.slug}`);
  lines.push("");
  if (topic.digest.trim()) {
    lines.push(`> ${topic.digest.trim()}`);
    lines.push("");
  }
  if (topic.consolidate) {
    lines.push(CONSOLIDATE_MARKER);
  }
  for (const e of topic.entries) {
    lines.push(serializeEntryLine(e));
  }
  return lines.join("\n") + "\n";
}

/** Serialized size used for the per-topic budget. Excludes ONLY the
 *  consolidation marker line (metadata, not content) — the baseline (slug +
 *  digest + entries + chrome) is unchanged from before the flag existed, so
 *  setting/clearing the flag never moves the reported usage. */
function currentBudget(topic: Topic): number {
  const full = serializeTopic(topic).length;
  return topic.consolidate ? full - (CONSOLIDATE_MARKER.length + 1) : full;
}

function dayStamp(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── VFS helpers + per-topic serialization ────────────────────────────────

async function ensureDir(agentId: string): Promise<void> {
  await vfs.mkdir(agentTopicsDir(agentId));
}

async function readTopicFile(agentId: string, slug: string): Promise<Topic | null> {
  const path = topicPath(agentId, slug);
  try {
    const raw = await vfs.readText(path);
    return parseTopic(normalizeSlug(slug), raw, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeTopicFile(agentId: string, topic: Topic): Promise<void> {
  await ensureDir(agentId);
  await vfs.writeText(topic.path, serializeTopic(topic));
  // Keep the agent's MEMORY.md index in sync with the topics on disk.
  await rebuildMemoryIndex(agentId).catch((err) =>
    logger().warn(LOG, "index rebuild failed", { agentId, err: (err as Error).message }),
  );
}

const locks = new Map<string, Promise<unknown>>();
function withTopicLock<T>(agentId: string, slug: string, fn: () => Promise<T>): Promise<T> {
  const key = `${agentId}/${normalizeSlug(slug)}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => undefined, () => undefined));
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

/** List all topic slugs currently on disk for an agent. */
export async function listTopicSlugs(agentId: string): Promise<string[]> {
  try {
    const entries = await vfs.list(agentTopicsDir(agentId));
    return entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .map((e) => e.name.replace(/\.md$/, ""));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** List the slugs of topics currently flagged for consolidation (M1). */
export async function listFlaggedTopicSlugs(agentId: string): Promise<string[]> {
  const slugs = await listTopicSlugs(agentId);
  const out: string[] = [];
  for (const slug of slugs) {
    const t = await readTopicFile(agentId, slug);
    if (t?.consolidate) out.push(slug);
  }
  return out;
}

/** Read a topic (null if it doesn't exist). */
export async function getTopic(agentId: string, slug: string): Promise<Topic | null> {
  return readTopicFile(agentId, slug);
}

/** Create a new topic (fails if it already exists). */
export async function createTopic(agentId: string, slug: string, digest: string = ""): Promise<TopicOpResult & { topic?: Topic }> {
  const s = normalizeSlug(slug);
  return withTopicLock(agentId, s, async () => {
    if (await readTopicFile(agentId, s)) return { success: false, error: `Topic "${s}" already exists.` };
    if (looksLikeInjection(digest)) {
      logger().warn(LOG, "topic digest refused", { agentId, slug: s, pattern: firstInjectionMatch(digest) });
      return { success: false, error: "Refused: digest matched a prompt-injection pattern." };
    }
    const topic: Topic = { slug: s, digest: digest.trim(), entries: [], path: topicPath(agentId, s) };
    await writeTopicFile(agentId, topic);
    logger().info(LOG, "topic created", { agentId, slug: s });
    return { success: true, message: `Topic "${s}" created.`, topic };
  });
}

/** Append an entry to a topic (creating it if missing). Over-budget saves
 *  SUCCEED and flag the topic for consolidation instead of being rejected
 *  (FR-001, T2 — soft budget). */
export async function addTopicEntry(agentId: string, slug: string, content: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const text = content.trim();
  if (!text) return { success: false, error: "content is required." };
  if (looksLikeInjection(text)) {
    logger().warn(LOG, "entry refused — injection", { agentId, slug: s, pattern: firstInjectionMatch(text) });
    return { success: false, error: "Refused: entry matched a prompt-injection pattern." };
  }
  const { topicBudget } = await getMemoryLoopsConfig();
  return withTopicLock(agentId, s, async () => {
    const topic = (await readTopicFile(agentId, s)) ?? {
      slug: s,
      digest: "",
      entries: [],
      path: topicPath(agentId, s),
    };
    if (topic.entries.some((e) => e.text === text)) {
      return { success: true, message: "Entry already present; no change.", usage: usageStr(topic, topicBudget) };
    }
    const entry: TopicEntry = { id: hashId(text), text, timestamp: dayStamp(), state: "active" };
    let next: Topic = { ...topic, entries: [...topic.entries, entry] };
    let flagged = false;
    if (currentBudget(next) > topicBudget) {
      next = { ...next, consolidate: true };
      flagged = true;
    }
    await writeTopicFile(agentId, next);
    logger().info(LOG, "entry added", { agentId, slug: s, flagged });
    return {
      success: true,
      message: flagged
        ? "Entry added. Topic is over its soft budget and has been flagged for the next consolidation pass."
        : "Entry added.",
      entryId: entry.id,
      usage: usageStr(next, topicBudget),
    };
  });
}

/** Replace ("supersede") an entry's text. Over-budget replaces SUCCEED and flag
 *  the topic for consolidation instead of being rejected (FR-001). A result
 *  that exactly duplicates another existing entry is deduped: the entry being
 *  replaced is dropped and the pre-existing duplicate is kept (FR-004). */
export async function replaceTopicEntry(
  agentId: string,
  slug: string,
  entryIdOrSubstring: string,
  newContent: string,
): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const text = newContent.trim();
  if (!text) return { success: false, error: "newContent is required (use remove_entry to delete)." };
  if (looksLikeInjection(text)) {
    logger().warn(LOG, "replace refused — injection", { agentId, slug: s, pattern: firstInjectionMatch(text) });
    return { success: false, error: "Refused: entry matched a prompt-injection pattern." };
  }
  const { topicBudget } = await getMemoryLoopsConfig();
  return withTopicLock(agentId, s, async () => {
    const topic = await readTopicFile(agentId, s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    const idx = findEntryIndex(topic, entryIdOrSubstring);
    if (idx < 0) return { success: false, error: `No matching entry for "${entryIdOrSubstring}".` };

    const dupIdx = topic.entries.findIndex((e, i) => i !== idx && e.text === text);
    if (dupIdx >= 0) {
      // The replacement text duplicates another entry already in the topic:
      // drop the entry being replaced and keep the pre-existing one (FR-004).
      const next: Topic = { ...topic, entries: topic.entries.filter((_, i) => i !== idx) };
      await writeTopicFile(agentId, next);
      return {
        success: true,
        message: "Entry replaced; result duplicated an existing entry, so the old entry was removed and the existing one kept.",
        entryId: topic.entries[dupIdx].id,
        usage: usageStr(next, topicBudget),
      };
    }

    const entries = topic.entries.slice();
    entries[idx] = { id: hashId(text), text, timestamp: dayStamp(), state: "active" };
    let next: Topic = { ...topic, entries };
    let flagged = false;
    if (currentBudget(next) > topicBudget) {
      next = { ...next, consolidate: true };
      flagged = true;
    }
    await writeTopicFile(agentId, next);
    return {
      success: true,
      message: flagged
        ? "Entry replaced. Topic is over its soft budget and has been flagged for the next consolidation pass."
        : "Entry replaced.",
      entryId: next.entries[idx].id,
      usage: usageStr(next, topicBudget),
    };
  });
}

/** Remove an entry from a topic. */
export async function removeTopicEntry(agentId: string, slug: string, entryIdOrSubstring: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const { topicBudget } = await getMemoryLoopsConfig();
  return withTopicLock(agentId, s, async () => {
    const topic = await readTopicFile(agentId, s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    const idx = findEntryIndex(topic, entryIdOrSubstring);
    if (idx < 0) return { success: false, error: `No matching entry for "${entryIdOrSubstring}".` };
    const next = { ...topic, entries: topic.entries.slice() };
    next.entries.splice(idx, 1);
    await writeTopicFile(agentId, next);
    return { success: true, message: "Entry removed.", usage: usageStr(next, topicBudget) };
  });
}

/** Refresh a topic's one-line digest (used by the consolidation pass after a
 *  reorganization, FR-006). */
export async function setTopicDigest(agentId: string, slug: string, digest: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  const d = digest.trim();
  if (!d) return { success: false, error: "digest is required." };
  if (looksLikeInjection(d)) {
    logger().warn(LOG, "digest refused — injection", { agentId, slug: s, pattern: firstInjectionMatch(d) });
    return { success: false, error: "Refused: digest matched a prompt-injection pattern." };
  }
  return withTopicLock(agentId, s, async () => {
    const topic = await readTopicFile(agentId, s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    const next: Topic = { ...topic, digest: d };
    await writeTopicFile(agentId, next);
    return { success: true, message: "Digest updated." };
  });
}

/** Clear a topic's consolidation flag. Called only after a successful
 *  reorganization pass (FR-007) — never speculatively. */
export async function clearConsolidateFlag(agentId: string, slug: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  return withTopicLock(agentId, s, async () => {
    const topic = await readTopicFile(agentId, s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    if (!topic.consolidate) return { success: true, message: "Flag already clear." };
    const next: Topic = { ...topic, consolidate: false };
    await writeTopicFile(agentId, next);
    return { success: true, message: "Consolidation flag cleared." };
  });
}

/** Mark an entry as superseded by another (newer) entry, without deleting it
 *  (FR-018, T4). The entry's id is unchanged (the id hash excludes the tag). */
export async function supersedeTopicEntry(
  agentId: string,
  slug: string,
  entryIdOrSubstring: string,
  supersededBy: { id: string; timestamp: string },
): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  return withTopicLock(agentId, s, async () => {
    const topic = await readTopicFile(agentId, s);
    if (!topic) return { success: false, error: `Topic "${s}" does not exist.` };
    const idx = findEntryIndex(topic, entryIdOrSubstring);
    if (idx < 0) return { success: false, error: `No matching entry for "${entryIdOrSubstring}".` };
    const entries = topic.entries.slice();
    entries[idx] = { ...entries[idx], state: "superseded", supersededBy };
    const next: Topic = { ...topic, entries };
    await writeTopicFile(agentId, next);
    return { success: true, message: "Entry marked superseded.", entryId: next.entries[idx].id };
  });
}

/** Delete an entire topic file, then rebuild the index. */
export async function deleteTopic(agentId: string, slug: string): Promise<TopicOpResult> {
  const s = normalizeSlug(slug);
  return withTopicLock(agentId, s, async () => {
    try {
      await vfs.remove(topicPath(agentId, s));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: false, error: `Topic "${s}" not found.` };
      }
      throw err;
    }
    await rebuildMemoryIndex(agentId).catch(() => undefined);
    logger().info(LOG, "topic deleted", { agentId, slug: s });
    return { success: true, message: `Topic "${s}" deleted.` };
  });
}

function findEntryIndex(topic: Topic, entryIdOrSubstring: string): number {
  const needle = entryIdOrSubstring.trim();
  if (!needle) return -1;
  const byId = topic.entries.findIndex((e) => e.id === needle);
  if (byId >= 0) return byId;
  const matches = topic.entries
    .map((e, i) => (e.text.includes(needle) ? i : -1))
    .filter((i) => i >= 0);
  if (matches.length !== 1) return -1;
  return matches[0];
}

/** As-of entry state (FR-020): active iff the entry existed by time T AND is
 *  not superseded-as-of-T (the superseding entry hadn't yet appeared by T). */
export function entryStateAt(e: TopicEntry, asOf: string): "active" | "superseded" | "not-yet-created" {
  if (e.timestamp > asOf) return "not-yet-created";
  if (e.state === "superseded" && e.supersededBy && e.supersededBy.timestamp <= asOf) return "superseded";
  return "active";
}
