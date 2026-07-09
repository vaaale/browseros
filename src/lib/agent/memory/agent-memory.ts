import "server-only";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { agentMemoryFile, agentMemoryRoot, agentTopicsDir } from "./paths";

// Per-agent MEMORY.md (023-per-agent-memory). Each agent's memory root holds one
// MEMORY.md with two sections:
//
//   # User preferences
//   <a short prose summary of who the user is and what they prefer — maintained
//    by the slow loop from episodic "profile suggestions">
//
//   # Memory index
//   | Memory file | Description |
//   | ----------- | ----------- |
//   | Topics/<slug>.md | <the topic's one-line digest> |
//
// The index is DERIVED: it is rebuilt from the Topics directory on every topic
// create/modify/remove, so it can never drift. The only human/agent-authored
// part is the User preferences prose. There is no separate USER.md and no
// flat "§"-delimited entry list anymore — durable knowledge lives in topics.

const LOG = "memory.agent-memory";

const H_PREFS = "# User preferences";
const H_INDEX = "# Memory index";
const PREFS_PLACEHOLDER = "_No user preferences recorded yet._";
const INDEX_PLACEHOLDER = "_No topics yet._";

export interface MemoryIndexRow {
  /** Path relative to the agent memory root, e.g. "Topics/gmail-workflows.md". */
  file: string;
  description: string;
}

export interface MemoryDoc {
  agentId: string;
  preferences: string;
  index: MemoryIndexRow[];
}

// ── Topic digest scan (kept here to avoid a topics.ts <-> agent-memory.ts cycle) ──

/** List the agent's topics as { slug, digest } by reading the Topics dir. */
async function scanTopicDigests(agentId: string): Promise<{ slug: string; digest: string }[]> {
  const dir = agentTopicsDir(agentId);
  let entries: Awaited<ReturnType<typeof vfs.list>>;
  try {
    entries = await vfs.list(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
  const out: { slug: string; digest: string }[] = [];
  for (const e of files) {
    const slug = e.name.replace(/\.md$/, "");
    let digest = "";
    try {
      const raw = await vfs.readText(e.path);
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("> ")) {
          digest = line.slice(2).trim();
          break;
        }
      }
    } catch {
      /* unreadable topic — still index it, just without a description */
    }
    out.push({ slug, digest });
  }
  out.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return out;
}

// ── Parse / serialize ──────────────────────────────────────────────────────

function parseMemoryDoc(agentId: string, raw: string): MemoryDoc {
  const text = raw.replace(/^﻿/, "");
  const idxPos = text.indexOf(`\n${H_INDEX}`);
  let prefsBlock = "";
  if (text.startsWith(H_PREFS)) {
    const afterPrefsHeader = text.slice(H_PREFS.length);
    prefsBlock = idxPos >= 0 ? text.slice(H_PREFS.length, idxPos) : afterPrefsHeader;
  } else if (idxPos < 0) {
    // No recognizable structure — treat the whole thing as preferences.
    prefsBlock = text;
  }
  const preferences = normalizePrefs(prefsBlock);
  return { agentId, preferences, index: parseIndexRows(idxPos >= 0 ? text.slice(idxPos) : "") };
}

function normalizePrefs(block: string): string {
  const t = block.trim();
  if (!t || t === PREFS_PLACEHOLDER) return "";
  return t;
}

function parseIndexRows(block: string): MemoryIndexRow[] {
  const rows: MemoryIndexRow[] = [];
  for (const line of block.split(/\r?\n/)) {
    const m = /^\|\s*(.+?)\s*\|\s*(.*?)\s*\|$/.exec(line.trim());
    if (!m) continue;
    const file = m[1];
    if (!file || file.toLowerCase() === "memory file" || /^-+$/.test(file)) continue;
    rows.push({ file, description: m[2] });
  }
  return rows;
}

function serializeMemoryDoc(preferences: string, index: MemoryIndexRow[]): string {
  const prefs = preferences.trim() || PREFS_PLACEHOLDER;
  const lines: string[] = [H_PREFS, "", prefs, "", H_INDEX, ""];
  if (index.length === 0) {
    lines.push(INDEX_PLACEHOLDER, "");
  } else {
    lines.push("| Memory file | Description |");
    lines.push("| ----------- | ----------- |");
    for (const r of index) lines.push(`| ${r.file} | ${r.description} |`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── VFS helpers ─────────────────────────────────────────────────────────────

async function readRaw(agentId: string): Promise<string | null> {
  try {
    return await vfs.readText(agentMemoryFile(agentId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Serialize writes per agent so setUserPreferences and rebuildMemoryIndex (which
// can be triggered concurrently by the slow loop and topic edits) don't clobber.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(agentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(agentId, run.then(() => undefined, () => undefined));
  return run;
}

/** Write MEMORY.md with the given preferences and a FRESH index computed from
 *  the Topics directory. Every write refreshes the index so it never drifts. */
async function writeMemory(agentId: string, preferences: string): Promise<void> {
  const digests = await scanTopicDigests(agentId);
  const index: MemoryIndexRow[] = digests.map((d) => ({
    file: `Topics/${d.slug}.md`,
    description: d.digest,
  }));
  await vfs.mkdir(agentMemoryRoot(agentId));
  await vfs.writeText(agentMemoryFile(agentId), serializeMemoryDoc(preferences, index));
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Parse the agent's MEMORY.md (empty doc when the file doesn't exist yet). */
export async function readMemoryDoc(agentId: string): Promise<MemoryDoc> {
  const raw = await readRaw(agentId);
  if (raw == null) return { agentId, preferences: "", index: [] };
  return parseMemoryDoc(agentId, raw);
}

/** Read only the "# User preferences" prose (empty string when unset). */
export async function getUserPreferences(agentId: string): Promise<string> {
  return (await readMemoryDoc(agentId)).preferences;
}

/** Replace the "# User preferences" prose. Rebuilds the index in the same write. */
export async function setUserPreferences(agentId: string, text: string): Promise<void> {
  await withLock(agentId, () => writeMemory(agentId, (text ?? "").trim()));
  logger().info(LOG, "user preferences updated", { agentId });
}

/** Rebuild the "# Memory index" table from the Topics directory, preserving the
 *  preferences prose. Call after any topic create/modify/remove. */
export async function rebuildMemoryIndex(agentId: string): Promise<void> {
  await withLock(agentId, async () => {
    const preferences = (await readMemoryDoc(agentId)).preferences;
    await writeMemory(agentId, preferences);
  });
}

/** The content injected into this agent's system prompt: the whole MEMORY.md
 *  (preferences + topic index) so the agent knows what it remembers and can
 *  memory_recall a topic on demand. Returns "" when there is nothing to inject. */
export async function memorySnapshotForAgent(agentId: string): Promise<string> {
  const doc = await readMemoryDoc(agentId);
  if (!doc.preferences && doc.index.length === 0) return "";
  const body = serializeMemoryDoc(doc.preferences, doc.index).trim();
  return `## Memory (persistent across sessions)\nThese are durable notes for you. Honor the user preferences; do not ask the user to repeat what is here. To read a topic listed in the index, call memory_recall with its slug.\n\n${body}`;
}
