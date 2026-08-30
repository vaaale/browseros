import "server-only";
import * as vfs from "@/os/vfs";
import { agentEpisodesDir } from "./paths";
import { getTopic, listTopicSlugs, topicPath } from "./topics";
import { embedQuery, getEmbedding } from "./embeddings";

// Per-agent memory search (023-per-agent-memory, spec 021 FR-017; hybrid
// dense+sparse ranking added by 028-memory-curation-retrieval, T3). Fuses
// dense (embedding) similarity, sparse (BM25) similarity, recency, and
// importance over /Memories/<agentId>/Topics/**.md (structured entries, with
// lifecycle state) and /Memories/<agentId>/Episodes/**.md (free-form lines).

export interface SearchResult {
  /** VFS path with an in-file anchor (e.g. #entry-3 or #lessons). */
  source: string;
  /** The matched line / entry, trimmed. */
  content: string;
  /** Fused relevance score in [0, 1] — higher = better. */
  score: number;
  /** Lifecycle state (topic entries only; episodes are always "active"). */
  state?: "active" | "superseded";
}

interface Candidate {
  kind: "topic" | "episode";
  source: string;
  content: string;
  /** yyyy-mm-dd, when known — drives the recency signal. */
  timestamp?: string;
  state?: "active" | "superseded";
  /** Present for topic entries — the content-hash id used as the embedding cache key. */
  entryId?: string;
}

// Below this "support" floor (max of dense, sparse) a candidate is dropped —
// it has neither strong lexical nor semantic support for the query (FR-014,
// ADR-7: the floor gates the SUPPORT signal, not the weighted fused score, so
// it behaves identically whether or not dense is available).
const RELEVANCE_FLOOR = 0.15;
// Bounded cold-cache dense burst (N2/R3): only the top-K sparse candidates get
// an embedding computed on a cold cache, capping cost at 1 query embed + ≤K
// corpus embeds per cold search. The rest join the dense signal once cached.
const DENSE_BURST_K = 10;
const FUSION_WEIGHTS = { dense: 0.4, sparse: 0.3, recency: 0.2, importance: 0.1 };
const RECENCY_HALFLIFE_DAYS = 30;
// No importance signal is computed yet anywhere in the codebase — always
// neutral (FR-017's documented fallback), not a bug.
const NEUTRAL_IMPORTANCE = 0.5;

// ── Public API ────────────────────────────────────────────────────────────

/** Search topics + episodes for a query. Ranked by a fused dense (embedding)
 *  + sparse (BM25) + recency + importance score, gated by a relevance floor
 *  on the raw dense/sparse support. Degrades gracefully (no error) when the
 *  provider can't serve embeddings — the dense term is dropped and the
 *  remaining signals are renormalized. */
export async function memorySearch(agentId: string, query: string, maxResults: number = 10): Promise<SearchResult[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const [topicCandidates, episodeCandidates] = await Promise.all([
    collectTopicCandidates(agentId),
    collectEpisodeCandidates(agentId),
  ]);
  const all = [...topicCandidates, ...episodeCandidates];
  if (all.length === 0) return [];

  const docs = all.map((c) => tokenize(c.content));
  const rawBm25 = bm25Scores(terms, docs);
  const maxBm25 = rawBm25.reduce((m, s) => Math.max(m, s), 0);
  const sparseScores = rawBm25.map((s) => (maxBm25 > 0 ? s / maxBm25 : 0));

  // Seed the dense signal for the top-K sparse TOPIC candidates only —
  // episodes have no stable per-entry id, so no cached-embedding identity.
  const denseSeedIdx = all
    .map((c, i) => ({ i, sparse: sparseScores[i], isTopic: c.kind === "topic" && !!c.entryId }))
    .filter((x) => x.isTopic)
    .sort((a, b) => b.sparse - a.sparse)
    .slice(0, DENSE_BURST_K)
    .map((x) => x.i);

  const denseScores: (number | null)[] = new Array(all.length).fill(null);
  if (denseSeedIdx.length > 0) {
    const queryEmbedding = await embedQuery(query);
    if (queryEmbedding) {
      await Promise.all(
        denseSeedIdx.map(async (i) => {
          const cand = all[i];
          if (!cand.entryId) return;
          const vec = await getEmbedding(agentId, { id: cand.entryId, text: cand.content });
          if (!vec) return;
          denseScores[i] = Math.max(0, cosine(queryEmbedding, vec));
        }),
      );
    }
  }

  const now = Date.now();
  const results: SearchResult[] = [];
  for (let i = 0; i < all.length; i++) {
    const cand = all[i];
    const sparse = sparseScores[i];
    const dense = denseScores[i];
    const support = Math.max(dense ?? 0, sparse);
    if (support < RELEVANCE_FLOOR) continue;
    const recency = recencyScore(cand.timestamp, now);
    const score = fuse(dense, sparse, recency, NEUTRAL_IMPORTANCE);
    results.push({ source: cand.source, content: cand.content, score, state: cand.state ?? "active" });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(1, maxResults));
}

// ── Fusion (isolated so weights/floor can move to config later — R6) ──────

function fuse(dense: number | null, sparse: number, recency: number, importance: number): number {
  const terms: { w: number; v: number }[] = [
    { w: FUSION_WEIGHTS.sparse, v: sparse },
    { w: FUSION_WEIGHTS.recency, v: recency },
    { w: FUSION_WEIGHTS.importance, v: importance },
  ];
  if (dense !== null) terms.push({ w: FUSION_WEIGHTS.dense, v: dense });
  const totalWeight = terms.reduce((s, t) => s + t.w, 0);
  if (totalWeight <= 0) return 0;
  const weighted = terms.reduce((s, t) => s + t.w * t.v, 0);
  return weighted / totalWeight;
}

function recencyScore(timestamp: string | undefined, now: number): number {
  if (!timestamp) return 0.5; // missing timestamp — neutral (FR-017)
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Sparse: lightweight in-memory BM25 ────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;.!?"'`()\[\]{}]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** BM25 (k1=1.5, b=0.75) over an in-memory corpus. Returns one raw (unbounded)
 *  score per document — callers max-normalize within the result set. */
function bm25Scores(queryTerms: string[], docs: string[][]): number[] {
  const N = docs.length;
  if (N === 0) return [];
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;

  const uniqueTerms = Array.from(new Set(queryTerms));
  const idf = new Map<string, number>();
  for (const t of uniqueTerms) {
    let df = 0;
    for (const d of docs) if (d.includes(t)) df += 1;
    idf.set(t, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  return docs.map((d) => {
    const len = d.length || 1;
    let score = 0;
    for (const t of uniqueTerms) {
      let tf = 0;
      for (const w of d) if (w === t) tf += 1;
      if (tf === 0) continue;
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + b * (len / avgdl));
      score += (idf.get(t) ?? 0) * (num / den);
    }
    return score;
  });
}

// ── Corpus collection ──────────────────────────────────────────────────────

async function collectTopicCandidates(agentId: string): Promise<Candidate[]> {
  const slugs = await listTopicSlugs(agentId);
  const out: Candidate[] = [];
  for (const slug of slugs) {
    const topic = await getTopic(agentId, slug);
    if (!topic) continue;
    topic.entries.forEach((e, i) => {
      out.push({
        kind: "topic",
        source: `${topicPath(agentId, slug)}#entry-${i}`,
        content: e.text,
        timestamp: e.timestamp,
        state: e.state ?? "active",
        entryId: e.id,
      });
    });
  }
  return out;
}

async function collectEpisodeCandidates(agentId: string): Promise<Candidate[]> {
  const dir = agentEpisodesDir(agentId);
  const files = await listMarkdownFiles(dir);
  const out: Candidate[] = [];
  for (const path of files) {
    let raw: string;
    try {
      raw = await vfs.readText(path);
    } catch {
      continue;
    }
    const filename = path.split("/").pop() ?? "";
    const dateMatch = /^(\d{4}-\d{2}-\d{2})-/.exec(filename);
    const timestamp = dateMatch ? dateMatch[1] : undefined;

    const lines = raw.split(/\r?\n/);
    let currentSection: string | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sec = /^##\s+(.+)$/.exec(trimmed);
      if (sec) {
        currentSection = sec[1].trim();
        continue;
      }
      const anchor = currentSection ? sectionAnchor(currentSection) : null;
      out.push({
        kind: "episode",
        source: anchor ? `${path}#${anchor}` : path,
        content: trimmed,
        timestamp,
      });
    }
  }
  return out;
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

/** Build an agent-scoped memory search tool for local sub-agents / the loops. */
export function makeMemorySearchTool(agentId: string): LlmTool {
  return {
    description:
      "Search this agent's long-term memory (topic shards + recent episodes) for entries matching a query, ranked by a fused dense (semantic) + sparse (keyword) + recency + importance score. Returns provenance (VFS path with in-file anchor), content, current/superseded state, and a relevance score. Degrades to keyword + recency + importance when the provider can't serve embeddings.",
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
      return JSON.stringify(await memorySearch(agentId, query, maxResults), null, 2);
    },
  };
}
