"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BookOpen,
  FileText,
  Info,
  Loader2,
  Notebook,
  Search,
  X,
} from "lucide-react";

interface RawResult {
  source: string;
  content: string;
  score: number;
}

interface FilterOption {
  id: FilterId;
  label: string;
}

type FilterId = "all" | "topics" | "episodes" | "memory";

const FILTERS: FilterOption[] = [
  { id: "all", label: "All Sources" },
  { id: "topics", label: "Topics" },
  { id: "episodes", label: "Episodes" },
  { id: "memory", label: "Memory" },
];

const INITIAL_PAGE_SIZE = 20;
const PAGE_INCREMENT = 20;
const DEBOUNCE_MS = 400;

function classifySource(source: string): FilterId {
  if (source.startsWith("/Documents/Memory/Topics/")) return "topics";
  if (source.startsWith("/Documents/Memory/Episodes/")) return "episodes";
  return "memory";
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;.!?"'`()[\]{}]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function highlightContent(content: string, terms: string[]): ReactNode {
  if (terms.length === 0) return content;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = content.split(re);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <mark
          key={i}
          className="rounded-sm bg-violet-400/25 px-0.5 font-semibold text-violet-100"
        >
          {part}
        </mark>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function sourceIcon(kind: FilterId): ReactNode {
  if (kind === "topics") return <BookOpen className="h-3 w-3" />;
  if (kind === "episodes") return <FileText className="h-3 w-3" />;
  return <Notebook className="h-3 w-3" />;
}

export default function SearchTab({ agentId }: { agentId: string }) {
  const [input, setInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [results, setResults] = useState<RawResult[]>([]);
  const [maxResults, setMaxResults] = useState(INITIAL_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const requestIdRef = useRef(0);

  const runSearch = useCallback(async (query: string, limit: number, more: boolean) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setActiveQuery("");
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    const reqId = ++requestIdRef.current;
    if (more) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const url = `/api/memory/search?agent=${encodeURIComponent(agentId)}&q=${encodeURIComponent(trimmed)}&maxResults=${limit}`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { query: string; results?: RawResult[] };
      if (reqId !== requestIdRef.current) return;
      setResults(Array.isArray(data.results) ? data.results : []);
      setActiveQuery(trimmed);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError((err as Error).message || "Search failed");
      if (!more) setResults([]);
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [agentId]);

  // Re-run the active search against the newly-selected agent. Deferred to avoid
  // cascading renders within the effect body.
  useEffect(() => {
    if (!activeQuery) return;
    const handle = setTimeout(() => void runSearch(activeQuery, maxResults, false), 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Debounced auto-search on input change.
  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed) {
      // Clear immediately when input emptied — deferred to avoid cascading renders.
      requestIdRef.current++;
      const clearHandle = setTimeout(() => {
        setResults([]);
        setActiveQuery("");
        setError(null);
        setLoading(false);
        setMaxResults(INITIAL_PAGE_SIZE);
      }, 0);
      return () => clearTimeout(clearHandle);
    }
    const handle = setTimeout(() => {
      setMaxResults(INITIAL_PAGE_SIZE);
      void runSearch(trimmed, INITIAL_PAGE_SIZE, false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input, runSearch]);

  const submitNow = useCallback(() => {
    setMaxResults(INITIAL_PAGE_SIZE);
    void runSearch(input, INITIAL_PAGE_SIZE, false);
  }, [input, runSearch]);

  const loadMore = useCallback(() => {
    const next = maxResults + PAGE_INCREMENT;
    setMaxResults(next);
    void runSearch(activeQuery, next, true);
  }, [activeQuery, maxResults, runSearch]);

  const clearInput = useCallback(() => {
    setInput("");
  }, []);

  const terms = useMemo(() => tokenize(activeQuery), [activeQuery]);
  const maxScore = useMemo(
    () => results.reduce((acc, r) => (r.score > acc ? r.score : acc), 0),
    [results],
  );

  // Filtered results (by source) + per-filter counts (for badges).
  const counts = useMemo(() => {
    const c = { all: results.length, topics: 0, episodes: 0, memory: 0 };
    for (const r of results) {
      const kind = classifySource(r.source);
      c[kind] += 1;
    }
    return c;
  }, [results]);

  const filteredResults = useMemo(() => {
    if (filter === "all") return results;
    return results.filter((r) => classifySource(r.source) === filter);
  }, [results, filter]);

  const canLoadMore =
    activeQuery.length > 0 &&
    results.length > 0 &&
    results.length >= maxResults; // API likely capped at maxResults; more may exist.

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3">
      {/* Search box */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitNow();
              }
              if (e.key === "Escape") clearInput();
            }}
            placeholder="Search across all memory surfaces…"
            aria-label="Search memory"
            className="w-full rounded-md border border-white/10 bg-black/30 py-2 pl-8 pr-8 text-xs text-white placeholder-white/30 outline-none focus:border-white/30"
            autoFocus
          />
          {input && (
            <button
              type="button"
              onClick={clearInput}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
              aria-label="Clear search"
              title="Clear"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={submitNow}
          disabled={loading || !input.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-3 py-2 text-[11px] font-medium text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Search className="h-3 w-3" />
          )}
          Search
        </button>
      </div>

      {/* Filter buttons */}
      <div className="flex shrink-0 flex-wrap gap-1">
        {FILTERS.map((opt) => {
          const isActive = filter === opt.id;
          const count = counts[opt.id];
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              aria-pressed={isActive}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                isActive
                  ? "border-violet-400/40 bg-violet-400/15 text-white"
                  : "border-white/10 bg-white/[0.03] text-white/70 hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <span>{opt.label}</span>
              {activeQuery && (
                <span
                  className={`rounded px-1 text-[10px] ${
                    isActive ? "bg-violet-400/25 text-violet-100" : "bg-white/10 text-white/60"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Results area */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-200">
            <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
            <span className="flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={submitNow}
              className="rounded border border-red-400/30 bg-red-400/15 px-1.5 py-0.5 text-[10px] font-medium text-red-100 hover:bg-red-400/25"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-[11px] text-white/50">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching…
          </div>
        ) : !activeQuery ? (
          <EmptyHero />
        ) : results.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-[11px] text-white/50">
            <Search className="h-5 w-5 text-white/25" />
            <span>
              No matches found for{" "}
              <span className="font-medium text-white/80">&ldquo;{activeQuery}&rdquo;</span>
            </span>
          </div>
        ) : (
          <>
            <div className="mb-2.5 text-[11px] text-white/60">
              Found{" "}
              <strong className="font-semibold text-white/90">
                {filteredResults.length} {filteredResults.length === 1 ? "match" : "matches"}
              </strong>
              {filter !== "all" && (
                <span className="text-white/40">
                  {" "}
                  · filtered from {results.length}
                </span>
              )}{" "}
              for <span className="font-medium text-white/80">&ldquo;{activeQuery}&rdquo;</span>
            </div>

            {filteredResults.length === 0 ? (
              <div className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-4 text-center text-[11px] text-white/45">
                No results in this source. Try another filter.
              </div>
            ) : (
              <ul className="space-y-2">
                {filteredResults.map((r, idx) => (
                  <ResultRow
                    key={`${r.source}-${idx}`}
                    result={r}
                    terms={terms}
                    maxScore={maxScore}
                  />
                ))}
              </ul>
            )}

            {canLoadMore && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-medium text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingMore ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  Load More Results
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ResultRow({
  result,
  terms,
  maxScore,
}: {
  result: RawResult;
  terms: string[];
  maxScore: number;
}) {
  const kind = classifySource(result.source);
  const relativePct = maxScore > 0 ? Math.round((result.score / maxScore) * 100) : 0;
  const { path, anchor } = splitAnchor(result.source);
  return (
    <li className="rounded-md border border-white/10 bg-white/[0.03] p-2.5 transition-colors hover:border-violet-400/30 hover:bg-violet-400/[0.06]">
      <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] text-violet-300">
        <span className="text-violet-300/80">{sourceIcon(kind)}</span>
        <span className="truncate" title={result.source}>
          {path}
          {anchor && <span className="text-violet-300/60">#{anchor}</span>}
        </span>
      </div>
      <div className="mb-1.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-white/85">
        {highlightContent(result.content, terms)}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-white/50">
        <span title={`Raw match count: ${result.score}`}>
          Relevance: <span className="text-white/70">{relativePct}%</span>
        </span>
        <span className="capitalize">{kind === "memory" ? "Memory" : kind}</span>
      </div>
    </li>
  );
}

function splitAnchor(source: string): { path: string; anchor: string | null } {
  const hashIdx = source.indexOf("#");
  if (hashIdx < 0) return { path: source, anchor: null };
  return { path: source.slice(0, hashIdx), anchor: source.slice(hashIdx + 1) };
}

function EmptyHero() {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center">
      <div className="rounded-full border border-white/10 bg-white/[0.03] p-3">
        <Search className="h-5 w-5 text-white/40" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-xs font-medium text-white/80">Search across all memory surfaces</p>
        <p className="text-[11px] leading-relaxed text-white/45">
          Look up entries in topic shards and episodes. Results are ranked by relevance and
          include their source location.
        </p>
      </div>
      <div className="mt-1 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[10.5px] text-white/60">
        <Info className="mt-[1px] h-3 w-3 shrink-0 text-white/40" />
        <span>Case-insensitive substring match. Terms of 2+ characters are indexed.</span>
      </div>
    </div>
  );
}
