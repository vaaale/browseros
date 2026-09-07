// Deterministic lexical ranking for find_tools (041-tool-groups, ADR-3),
// replacing discovery-score.ts's `scoreCapability`.
//
// Framework-free and PURE: no I/O, no model call, no network. Callers resolve
// the effective capability/group view and hand it in. That is what lets the
// server tool and the tests share one implementation, and what makes SC-004's
// benchmark meaningful.
//
// What the old scorer got wrong, and this fixes: it matched the ENTIRE query
// string as a substring against descriptions and group names, so for any
// multi-word natural-language query ("send an email to my colleague") only the
// id-word rule could ever fire — every description and group signal was dead
// weight for exactly the queries they existed to serve. Ranking here is
// per-term, IDF-weighted, stopword-filtered and morphology-tolerant.

import type { Capability } from "./capabilities-registry";
import type { ToolGroup } from "./tool-groups";

// ── Tokenization ────────────────────────────────────────────────────────────

// Words that carry no retrieval value. Without this, "send an email TO bob"
// matches `file_to_markdown` on the word "to" (FR-018/SC-005). Kept small and
// closed: an over-eager stopword list silently removes real signal.
const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "get", "give", "had", "has", "have", "how", "i",
  "if", "in", "into", "is", "it", "its", "just", "let", "like", "make", "me", "my", "need",
  "no", "not", "of", "on", "one", "or", "our", "out", "over", "please", "put", "should",
  "so", "some", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "to", "up", "us", "want", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
]);

/** Crude, deterministic suffix folding. Not linguistically correct and not
 *  trying to be — both the query and the corpus go through the SAME function,
 *  so what matters is that "files"/"file" and "listing"/"list" collide. */
function foldOnce(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  // Only strip "es" after a sibilant ("boxes", "matches"); otherwise "files"
  // becomes "fil" and never collides with "file".
  if (word.length > 4 && /(ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Applied to FIXPOINT, not once. A single pass folds "settings" -> "setting"
 *  but "setting" -> "sett", so the query and the corpus word would never
 *  collide — which is the entire job. Bounded at 3 passes. */
function fold(word: string): string {
  let out = word;
  for (let i = 0; i < 3; i++) {
    const next = foldOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Lowercase → split on non-alphanumerics → drop 1-char tokens and stopwords →
 *  fold. Order matters: stopwords are checked BEFORE folding, so "was" is not
 *  folded to "wa" and then kept. */
export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(fold);
}

// ── Index ───────────────────────────────────────────────────────────────────

export type SearchField = "id" | "alias" | "description" | "group" | "groupAlias" | "groupDescription";

/** Field weights. `id` and curated `alias` outrank prose because they are
 *  authored to be matched; group-level fields are weakest because they are
 *  shared by every member of the group. */
const FIELD_WEIGHT: Record<SearchField, number> = {
  id: 5,
  alias: 4,
  description: 3,
  group: 2,
  // A GROUP's aliases are shared by every member, so they must not carry a
  // capability's own alias weight — otherwise "pdf" as a Files group alias
  // lifts all 13 file tools above the one whose own description says "PDF".
  groupAlias: 1.5,
  groupDescription: 1,
};

interface SearchDoc {
  id: string;
  groupId: string;
  /** term -> the highest-weight field that term appears in, plus every field. */
  fields: Map<string, Set<SearchField>>;
}

export interface SearchIndex {
  docs: SearchDoc[];
  /** term -> number of docs containing it. */
  df: Map<string, number>;
  size: number;
}

function addTerms(fields: Map<string, Set<SearchField>>, text: string, field: SearchField): void {
  for (const term of tokenize(text)) {
    const set = fields.get(term) ?? new Set<SearchField>();
    set.add(field);
    fields.set(term, set);
  }
}

/**
 * Build the inverted-ish index over the capabilities a caller cares about.
 *
 * Group name/description are indexed PER CAPABILITY on purpose: it is what
 * makes a group-level query surface that group's members (FR-034). Note this
 * does not need special weighting to behave — because a group's terms repeat
 * across every member, IDF discounts them automatically, which is correct: a
 * term on all 13 Gmail tools is weak evidence for any ONE of them while still
 * lifting the whole group above unrelated tools. Do not "fix" that by boosting
 * group fields; it reintroduces the group-level flooding the old flat +1/+2
 * rules produced.
 */
export function buildIndex(caps: Capability[], groups: ToolGroup[]): SearchIndex {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const docs: SearchDoc[] = caps.map((c) => {
    const fields = new Map<string, Set<SearchField>>();
    addTerms(fields, c.id, "id");
    addTerms(fields, c.description, "description");
    for (const alias of c.aliases ?? []) addTerms(fields, alias, "alias");
    const group = byId.get(c.group);
    if (group) {
      addTerms(fields, group.name, "group");
      addTerms(fields, group.description, "groupDescription");
      for (const alias of group.aliases) addTerms(fields, alias, "groupAlias");
    }
    return { id: c.id, groupId: c.group, fields };
  });

  // Document frequency counts a term only where a capability OWNS it (its id,
  // description, or its own aliases) — never where a group propagated it. A
  // group's terms land on every member by construction, so counting them would
  // make a genuinely rare word look common purely because its group also
  // mentions it, and would then discount the one tool that really is about it.
  const OWNED: SearchField[] = ["id", "description", "alias"];
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const [term, fields] of doc.fields) {
      if (OWNED.some((f) => fields.has(f))) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return { docs, df, size: docs.length };
}

function idf(index: SearchIndex, term: string): number {
  const df = index.df.get(term) ?? 0;
  // Smoothed: a term in every doc still contributes a little, a term in one doc
  // contributes a lot, and an unseen term contributes nothing that matters.
  return Math.log(1 + index.size / (1 + df));
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface MatchReason {
  term: string;
  field: SearchField;
}

export interface ScoredCapability {
  id: string;
  score: number;
  reasons: MatchReason[];
}

/** Fraction of the best conceivable score a result must reach to be returned.
 *  Replaces "any non-zero score", which returned junk at the same rank as a
 *  real hit (FR-022). Tuned against tests/agent/fixtures/discovery-benchmark.ts. */
const RELEVANCE_FLOOR = 0.1;

/** Scores one document. Returns 0 with no reasons when nothing matched. */
function scoreDoc(doc: SearchDoc, terms: string[], index: SearchIndex): { score: number; reasons: MatchReason[] } {
  let raw = 0;
  let matched = 0;
  const reasons: MatchReason[] = [];
  for (const term of terms) {
    const fields = doc.fields.get(term);
    if (!fields) continue;
    matched += 1;
    // Only the strongest field a term hits contributes, so a term repeated
    // across id+description+group doesn't triple-count.
    let best: SearchField = "groupDescription";
    for (const f of fields) if (FIELD_WEIGHT[f] > FIELD_WEIGHT[best]) best = f;
    raw += FIELD_WEIGHT[best] * idf(index, term);
    reasons.push({ term, field: best });
  }
  if (matched === 0) return { score: 0, reasons: [] };
  // Coverage bonus (FR-021): matching MORE DISTINCT query terms beats matching
  // one term heavily, so a tool that answers the whole question outranks one
  // that answers a word of it.
  const coverage = matched / terms.length;
  return { score: raw * (0.5 + 0.5 * coverage), reasons };
}

export interface SearchOptions {
  /** Restrict to these capability ids (the caller's gate). */
  eligible?: Set<string>;
  /** Restrict to one group id (group-scoped mode). */
  groupId?: string;
}

export interface SearchOutcome {
  /** Ranked hits above the relevance floor, best first. */
  results: ScoredCapability[];
  /** Query produced no usable terms (empty, too short, all stopwords). */
  unsearchable: boolean;
  /** The folded terms actually searched — useful in an explanatory message. */
  terms: string[];
}

/**
 * Rank capabilities against a free-text query.
 *
 * Ordering is total and deterministic: score desc, then the caller's document
 * order (which is registry order, itself group-table order), then id. No two
 * runs can disagree.
 */
export function search(query: string, index: SearchIndex, opts: SearchOptions = {}): SearchOutcome {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return { results: [], unsearchable: true, terms };

  const position = new Map(index.docs.map((d, i) => [d.id, i]));
  const scored: ScoredCapability[] = [];
  let top = 0;
  for (const doc of index.docs) {
    if (opts.eligible && !opts.eligible.has(doc.id)) continue;
    if (opts.groupId && doc.groupId !== opts.groupId) continue;
    const { score, reasons } = scoreDoc(doc, terms, index);
    if (score <= 0) continue;
    if (score > top) top = score;
    scored.push({ id: doc.id, score, reasons });
  }

  // Best conceivable score for this query: every KNOWN term hitting the id
  // field. Terms nobody has are excluded — otherwise a query carrying an
  // unindexed word ("metric", "units") raises the bar that the genuinely
  // relevant tool then fails to clear, and the search returns nothing.
  const known = terms.filter((t) => (index.df.get(t) ?? 0) > 0);
  const ceiling = known.reduce((sum, t) => sum + FIELD_WEIGHT.id * idf(index, t), 0);
  const floor = ceiling * RELEVANCE_FLOOR;

  const results = scored
    .filter((r) => r.score >= floor)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pa = position.get(a.id) ?? 0;
      const pb = position.get(b.id) ?? 0;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  return { results, unsearchable: false, terms };
}
