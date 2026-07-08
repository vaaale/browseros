import "server-only";
import * as vfs from "@/os/vfs";
import { EPISODES_DIR } from "./episodes";
import { TOPICS_DIR } from "./topics";

// Memory search (spec 021 FR-017). Substring/word-match ranking over
// /Documents/Memory/Topics/**.md and /Documents/Memory/Episodes/**.md. No new
// dependencies. Ranking is isolated behind `rankMatches` so a BM25 (or
// vector) swap later doesn't touch the public interface.

export interface SearchResult {
  /** VFS path with an in-file anchor (e.g. #entry-3 or #lessons). */
  source: string;
  /** The matched line / entry, trimmed. */
  content: string;
  /** Relevance score — higher = better. Currently token-count-based. */
  score: number;
}

interface FileHit {
  source: string;
  content: string;
  matches: number;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Search topics + episodes for a query. Case-insensitive, whitespace-split
 *  terms; returns up to `maxResults` matches ranked by descending score. */
export async function memorySearch(query: string, maxResults: number = 10): Promise<SearchResult[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const [topics, episodes] = await Promise.all([
    collectHits(TOPICS_DIR, terms, "topic"),
    collectHits(EPISODES_DIR, terms, "episode"),
  ]);
  const all = [...topics, ...episodes];
  return rankMatches(all).slice(0, Math.max(1, maxResults));
}

// ── Ranking (isolated for future BM25 swap) ──────────────────────────────

function rankMatches(hits: FileHit[]): SearchResult[] {
  return hits
    .filter((h) => h.matches > 0)
    .sort((a, b) => b.matches - a.matches)
    .map((h) => ({ source: h.source, content: h.content, score: h.matches }));
}

// ── Scanning ─────────────────────────────────────────────────────────────

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;.!?"'`()\[\]{}]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function countMatches(haystack: string, terms: string[]): number {
  const lc = haystack.toLowerCase();
  let n = 0;
  for (const t of terms) {
    let idx = lc.indexOf(t);
    while (idx !== -1) {
      n += 1;
      idx = lc.indexOf(t, idx + t.length);
    }
  }
  return n;
}

async function collectHits(dir: string, terms: string[], kind: "topic" | "episode"): Promise<FileHit[]> {
  const files = await listMarkdownFiles(dir);
  const out: FileHit[] = [];
  for (const path of files) {
    let raw: string;
    try {
      raw = await vfs.readText(path);
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    let currentSection: string | null = null;
    let entryIdx = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sec = /^##\s+(.+)$/.exec(trimmed);
      if (sec) {
        currentSection = sec[1].trim();
        entryIdx = 0;
        continue;
      }
      const isEntry = kind === "topic" ? /^-\s+\[/.test(trimmed) : trimmed.length > 0;
      if (!isEntry) continue;
      const matches = countMatches(trimmed, terms);
      if (matches === 0) continue;
      const anchor = anchorFor(kind, currentSection, entryIdx);
      out.push({
        source: anchor ? `${path}#${anchor}` : path,
        content: trimmed,
        matches,
      });
      entryIdx += 1;
    }
  }
  return out;
}

function anchorFor(kind: "topic" | "episode", section: string | null, entryIdx: number): string | null {
  if (kind === "topic") return `entry-${entryIdx}`;
  if (kind === "episode" && section) return sectionAnchor(section);
  return null;
}

function sectionAnchor(section: string): string {
  return section.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

async function listMarkdownFiles(vfsDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string): Promise<void> {
    try {
      const entries = await vfs.list(p);
      for (const e of entries) {
        // Skip archive by convention (spec §Archive: episodes older than N days).
        if (e.name === ".Archive") continue;
        if (e.type === "dir") await walk(e.path);
        else if (e.type === "file" && e.name.endsWith(".md")) out.push(e.path);
      }
    } catch {
      /* dir doesn't exist yet — that's fine */
    }
  }
  await walk(vfsDir);
  return out;
}

// ── LlmTool wrapper (registered by curated.ts's memory tool bundle) ──────

import type { LlmTool } from "@/lib/agent/llm";

export const MEMORY_SEARCH_TOOL: LlmTool = {
  description:
    "Search long-term memory (topic shards + recent episodes) for entries matching a query. Returns provenance (VFS path with in-file anchor), content, and a relevance score. Case-insensitive substring match; no vector search.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      maxResults: { type: "number", description: "Default 10." },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const query = String(input.query ?? "");
    const maxResults = typeof input.maxResults === "number" ? input.maxResults : 10;
    return JSON.stringify(await memorySearch(query, maxResults), null, 2);
  },
};
