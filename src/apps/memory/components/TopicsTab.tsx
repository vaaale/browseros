"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  FileText,
  Info,
  Lightbulb,
  Loader2,
  Plus,
  RefreshCw,
  Ruler,
  Trash2,
  X,
} from "lucide-react";

interface TopicMetaView {
  slug: string;
  digest?: string;
  entryCount: number;
  charUsage: number;
  budget: number;
}

interface TopicEntryView {
  id: string;
  text: string;
  timestamp: string;
}

interface TopicDetail {
  topic: string;
  digest: string;
  entries: TopicEntryView[];
}

interface TopicOpResult {
  success: boolean;
  error?: string;
  message?: string;
  usage?: string;
  entryId?: string;
  topic?: { slug: string };
}

interface ListState {
  topics: TopicMetaView[];
  loading: boolean;
  error: string | null;
}

interface DetailState {
  data: TopicDetail | null;
  budget: number;
  loading: boolean;
  error: string | null;
}

const INITIAL_LIST: ListState = { topics: [], loading: true, error: null };
const INITIAL_DETAIL: DetailState = { data: null, budget: 4000, loading: false, error: null };

// Match the topic serializer: "- [YYYY-MM-DD] <text>\n"
function estimateEntryCharCost(text: string): number {
  return `- [YYYY-MM-DD] ${text}`.length + 1;
}

export default function TopicsTab({ agentId }: { agentId: string }) {
  const agentQ = `agent=${encodeURIComponent(agentId)}`;
  const [list, setList] = useState<ListState>(INITIAL_LIST);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>(INITIAL_DETAIL);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<null | "add" | "delete-entry" | "delete-topic" | "create">(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [confirmingDeleteTopic, setConfirmingDeleteTopic] = useState(false);
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setList((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`/api/memory/topics?${agentQ}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { topics?: TopicMetaView[] };
      setList({
        topics: Array.isArray(data.topics) ? data.topics : [],
        loading: false,
        error: null,
      });
    } catch (err) {
      setList({ topics: [], loading: false, error: (err as Error).message || "Failed to load topics" });
    }
  }, [agentQ]);

  const loadDetail = useCallback(
    async (slug: string, budget: number) => {
      setDetail({ data: null, budget, loading: true, error: null });
      try {
        const res = await fetch(`/api/memory?${agentQ}&topic=${encodeURIComponent(slug)}`);
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as TopicDetail;
        setDetail({
          data: {
            topic: data.topic,
            digest: data.digest || "",
            entries: Array.isArray(data.entries) ? data.entries : [],
          },
          budget,
          loading: false,
          error: null,
        });
      } catch (err) {
        setDetail({ data: null, budget, loading: false, error: (err as Error).message || "Failed to load topic" });
      }
    },
    [agentQ],
  );

  // Reset selection and reload the list whenever the list loader changes
  // (which happens when the selected agent changes). All state updates are
  // deferred to avoid cascading renders within the effect body.
  useEffect(() => {
    const id = setTimeout(() => {
      setSelected(null);
      setDetail(INITIAL_DETAIL);
      void loadList();
    }, 0);
    return () => clearTimeout(id);
  }, [loadList]);

  const selectTopic = useCallback(
    (meta: TopicMetaView) => {
      setSelected(meta.slug);
      setConfirmingDeleteTopic(false);
      setPendingDeleteEntry(null);
      setOpError(null);
      void loadDetail(meta.slug, meta.budget);
    },
    [loadDetail],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list.topics;
    return list.topics.filter((t) => t.slug.toLowerCase().includes(q));
  }, [list.topics, search]);

  const selectedMeta = useMemo(
    () => (selected ? list.topics.find((t) => t.slug === selected) ?? null : null),
    [list.topics, selected],
  );

  const refreshAfterMutation = useCallback(async () => {
    // Reload the list (charUsage/entryCount changed) and the detail pane. Fetch
    // both directly here so we can hand the new budget to loadDetail without
    // relying on stale React state from `list`.
    try {
      const listRes = await fetch(`/api/memory/topics?${agentQ}`);
      const listData = (await listRes.json().catch(() => ({}))) as { topics?: TopicMetaView[] };
      const topics = Array.isArray(listData.topics) ? listData.topics : [];
      setList({ topics, loading: false, error: null });
      if (selected) {
        const meta = topics.find((t) => t.slug === selected);
        await loadDetail(selected, meta?.budget ?? detail.budget);
      }
    } catch (err) {
      setList({ topics: [], loading: false, error: (err as Error).message || "Failed to reload" });
    }
  }, [agentQ, detail.budget, loadDetail, selected]);

  const addEntry = useCallback(
    async (content: string): Promise<boolean> => {
      if (!selected) return false;
      setBusy("add");
      setOpError(null);
      try {
        const res = await fetch(`/api/memory?${agentQ}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "topic", action: "add", topic: selected, content }),
        });
        const data = (await res.json().catch(() => ({}))) as TopicOpResult;
        if (!res.ok || !data.success) {
          setOpError(data.error || `Failed (HTTP ${res.status})`);
          return false;
        }
        await refreshAfterMutation();
        return true;
      } catch (err) {
        setOpError((err as Error).message || "Failed to add entry");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [agentQ, refreshAfterMutation, selected],
  );

  const deleteEntry = useCallback(
    async (entryId: string) => {
      if (!selected) return;
      setBusy("delete-entry");
      setOpError(null);
      try {
        const res = await fetch(
          `/api/memory?${agentQ}&target=topic&topic=${encodeURIComponent(selected)}&id=${encodeURIComponent(entryId)}`,
          { method: "DELETE" },
        );
        const data = (await res.json().catch(() => ({}))) as TopicOpResult;
        if (!res.ok || !data.success) {
          setOpError(data.error || `Failed (HTTP ${res.status})`);
          return;
        }
        setPendingDeleteEntry(null);
        await refreshAfterMutation();
      } catch (err) {
        setOpError((err as Error).message || "Failed to delete entry");
      } finally {
        setBusy(null);
      }
    },
    [agentQ, refreshAfterMutation, selected],
  );

  const deleteTopic = useCallback(async () => {
    if (!selected) return;
    setBusy("delete-topic");
    setOpError(null);
    try {
      const res = await fetch(`/api/memory?${agentQ}&target=topic&topic=${encodeURIComponent(selected)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as TopicOpResult;
      if (!res.ok || !data.success) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setConfirmingDeleteTopic(false);
      setSelected(null);
      setDetail(INITIAL_DETAIL);
      await loadList();
    } catch (err) {
      setOpError((err as Error).message || "Failed to delete topic");
    } finally {
      setBusy(null);
    }
  }, [agentQ, loadList, selected]);

  const createTopic = useCallback(
    async (slug: string) => {
      setBusy("create");
      setOpError(null);
      try {
        const res = await fetch(`/api/memory?${agentQ}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "topic", action: "create", topic: slug }),
        });
        const data = (await res.json().catch(() => ({}))) as TopicOpResult;
        if (!res.ok || !data.success) {
          setOpError(data.error || `Failed (HTTP ${res.status})`);
          return false;
        }
        // Fetch fresh list, then select the new topic using the meta's own budget.
        const listRes = await fetch(`/api/memory/topics?${agentQ}`);
        const listData = (await listRes.json().catch(() => ({}))) as { topics?: TopicMetaView[] };
        const topics = Array.isArray(listData.topics) ? listData.topics : [];
        setList({ topics, loading: false, error: null });
        const normalized = data.topic?.slug ?? slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        const meta = topics.find((t) => t.slug === normalized);
        if (meta) {
          setSelected(meta.slug);
          void loadDetail(meta.slug, meta.budget);
        }
        return true;
      } catch (err) {
        setOpError((err as Error).message || "Failed to create topic");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [agentQ, loadDetail],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <ListPane
        list={list}
        filtered={filtered}
        search={search}
        onSearchChange={setSearch}
        selected={selected}
        onSelect={selectTopic}
        onReload={loadList}
        onCreate={createTopic}
        creating={busy === "create"}
      />
      <DetailPane
        selectedMeta={selectedMeta}
        detail={detail}
        busy={busy}
        opError={opError}
        onDismissError={() => setOpError(null)}
        confirmingDeleteTopic={confirmingDeleteTopic}
        onRequestDeleteTopic={() => {
          setConfirmingDeleteTopic(true);
          setOpError(null);
        }}
        onCancelDeleteTopic={() => setConfirmingDeleteTopic(false)}
        onConfirmDeleteTopic={deleteTopic}
        pendingDeleteEntry={pendingDeleteEntry}
        onRequestDeleteEntry={(id) => {
          setPendingDeleteEntry(id);
          setOpError(null);
        }}
        onCancelDeleteEntry={() => setPendingDeleteEntry(null)}
        onConfirmDeleteEntry={deleteEntry}
        onAddEntry={addEntry}
        onRetryDetail={() => selected && void loadDetail(selected, detail.budget)}
      />
    </div>
  );
}

// ── Left pane ──────────────────────────────────────────────────────────────

interface ListPaneProps {
  list: ListState;
  filtered: TopicMetaView[];
  search: string;
  onSearchChange: (v: string) => void;
  selected: string | null;
  onSelect: (meta: TopicMetaView) => void;
  onReload: () => void;
  onCreate: (slug: string) => Promise<boolean>;
  creating: boolean;
}

function ListPane({
  list,
  filtered,
  search,
  onSearchChange,
  selected,
  onSelect,
  onReload,
  onCreate,
  creating,
}: ListPaneProps) {
  const [drafting, setDrafting] = useState(false);
  const [draftSlug, setDraftSlug] = useState("");

  const submitNew = async () => {
    const slug = draftSlug.trim();
    if (!slug) return;
    const ok = await onCreate(slug);
    if (ok) {
      setDrafting(false);
      setDraftSlug("");
    }
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-3.5 w-3.5 text-white/70" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/80">Topics</h2>
          <span className="text-[11px] text-white/40">({list.topics.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onReload}
            disabled={list.loading}
            className="rounded-md border border-white/10 bg-white/[0.05] p-1 text-white/70 hover:bg-white/10 disabled:opacity-50"
            aria-label="Reload topics"
            title="Reload"
          >
            <RefreshCw className={`h-3 w-3 ${list.loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setDrafting((v) => !v)}
            disabled={list.loading || creating}
            className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20 disabled:opacity-50"
            aria-label="New topic"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
      </header>

      <div className="shrink-0 border-b border-white/10 bg-white/[0.02] p-2">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search topics…"
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-white placeholder-white/30 outline-none focus:border-white/30"
          aria-label="Filter topics by name"
        />
        {drafting && (
          <div className="mt-2 rounded-md border border-violet-400/30 bg-violet-400/5 p-2">
            <input
              type="text"
              value={draftSlug}
              onChange={(e) => setDraftSlug(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitNew();
                if (e.key === "Escape") {
                  setDrafting(false);
                  setDraftSlug("");
                }
              }}
              placeholder="new-topic-slug"
              autoFocus
              className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-white placeholder-white/30 outline-none focus:border-white/30"
            />
            <div className="mt-2 flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => {
                  setDrafting(false);
                  setDraftSlug("");
                }}
                disabled={creating}
                className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/80 hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitNew}
                disabled={creating || !draftSlug.trim()}
                className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Create
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.loading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={onReload} />
        ) : list.topics.length === 0 ? (
          <EmptyState label="No topics yet." />
        ) : filtered.length === 0 ? (
          <EmptyState label="No topics match your search." />
        ) : (
          <ul className="space-y-1">
            {filtered.map((meta) => (
              <TopicListRow
                key={meta.slug}
                meta={meta}
                selected={meta.slug === selected}
                onClick={() => onSelect(meta)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TopicListRow({
  meta,
  selected,
  onClick,
}: {
  meta: TopicMetaView;
  selected: boolean;
  onClick: () => void;
}) {
  const pct = meta.budget > 0 ? Math.min(100, (meta.charUsage / meta.budget) * 100) : 0;
  const tone = pct > 80 ? "danger" : pct >= 50 ? "warning" : "ok";
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
          selected
            ? "border-violet-400/40 bg-violet-400/10"
            : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]"
        }`}
        aria-pressed={selected}
      >
        <div className="mb-1 truncate text-[11px] font-medium text-white/90" title={meta.slug}>
          {meta.slug}
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-white/55">
          <span className="inline-flex items-center gap-1">
            <FileText className="h-2.5 w-2.5" />
            {meta.entryCount} {meta.entryCount === 1 ? "entry" : "entries"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Ruler className="h-2.5 w-2.5" />
            {meta.charUsage.toLocaleString()} / {meta.budget.toLocaleString()} chars
          </span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full transition-all ${
              tone === "danger" ? "bg-red-400" : tone === "warning" ? "bg-amber-400" : "bg-emerald-400"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </button>
    </li>
  );
}

// ── Right pane ─────────────────────────────────────────────────────────────

interface DetailPaneProps {
  selectedMeta: TopicMetaView | null;
  detail: DetailState;
  busy: null | "add" | "delete-entry" | "delete-topic" | "create";
  opError: string | null;
  onDismissError: () => void;
  confirmingDeleteTopic: boolean;
  onRequestDeleteTopic: () => void;
  onCancelDeleteTopic: () => void;
  onConfirmDeleteTopic: () => void;
  pendingDeleteEntry: string | null;
  onRequestDeleteEntry: (id: string) => void;
  onCancelDeleteEntry: () => void;
  onConfirmDeleteEntry: (id: string) => void;
  onAddEntry: (content: string) => Promise<boolean>;
  onRetryDetail: () => void;
}

function DetailPane({
  selectedMeta,
  detail,
  busy,
  opError,
  onDismissError,
  confirmingDeleteTopic,
  onRequestDeleteTopic,
  onCancelDeleteTopic,
  onConfirmDeleteTopic,
  pendingDeleteEntry,
  onRequestDeleteEntry,
  onCancelDeleteEntry,
  onConfirmDeleteEntry,
  onAddEntry,
  onRetryDetail,
}: DetailPaneProps) {
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");

  const budget = selectedMeta?.budget ?? detail.budget;
  const charUsage = selectedMeta?.charUsage ?? 0;
  const remaining = Math.max(0, budget - charUsage);
  const draftCost = drafting ? estimateEntryCharCost(draft.trim()) : 0;
  const overBudget = drafting && draft.trim() && draftCost > remaining;

  const submitDraft = async () => {
    const content = draft.trim();
    if (!content) return;
    const ok = await onAddEntry(content);
    if (ok) {
      setDraft("");
      setDrafting(false);
    }
  };

  const cancelDraft = () => {
    setDrafting(false);
    setDraft("");
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <BookOpen className="h-3.5 w-3.5 text-violet-300" />
          <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-white/80">
            {detail.data ? detail.data.topic : "Topic Details"}
          </h2>
          {detail.data && (
            <span className="text-[11px] text-white/40">({detail.data.entries.length})</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDrafting((v) => !v)}
            disabled={!detail.data || busy !== null}
            className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Add entry"
          >
            <Plus className="h-3 w-3" />
            <span className="hidden sm:inline">Entry</span>
          </button>
          {confirmingDeleteTopic ? (
            <div className="flex items-center gap-1 rounded-md border border-red-400/30 bg-red-400/10 px-1.5 py-1 text-[11px]">
              <span className="hidden text-red-100 sm:inline">Delete topic?</span>
              <button
                type="button"
                onClick={onConfirmDeleteTopic}
                disabled={busy !== null}
                className="rounded border border-red-400/40 bg-red-400/20 p-0.5 text-red-100 hover:bg-red-400/30 disabled:opacity-50"
                aria-label="Confirm delete topic"
                title="Confirm delete"
              >
                {busy === "delete-topic" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                onClick={onCancelDeleteTopic}
                disabled={busy !== null}
                className="rounded border border-white/10 bg-white/[0.05] p-0.5 text-white/70 hover:bg-white/10 disabled:opacity-50"
                aria-label="Cancel delete topic"
                title="Cancel"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onRequestDeleteTopic}
              disabled={!detail.data || busy !== null}
              title="Delete this topic"
              aria-label="Delete topic"
              className="inline-flex items-center gap-1 rounded-md border border-red-400/30 bg-red-400/10 px-2 py-1 text-[11px] font-medium text-red-100 hover:bg-red-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {opError && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-200">
            <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
            <span className="flex-1 break-words">{opError}</span>
            <button
              type="button"
              onClick={onDismissError}
              className="rounded p-0.5 hover:bg-white/10"
              aria-label="Dismiss error"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {drafting && detail.data && (
          <div className="mb-3 rounded-md border border-violet-400/30 bg-violet-400/5 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`New entry for "${detail.data.topic}"…`}
              rows={3}
              autoFocus
              className="w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-white/30"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span
                className={`text-[10px] ${
                  overBudget ? "text-red-300" : "text-white/40"
                }`}
              >
                {draft.trim().length} chars
                {overBudget && ` · would exceed budget (${draftCost} > ${remaining} remaining)`}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={cancelDraft}
                  disabled={busy === "add"}
                  className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/80 hover:bg-white/10 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitDraft}
                  disabled={busy === "add" || !draft.trim()}
                  className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "add" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {detail.loading ? (
          <LoadingState />
        ) : detail.error ? (
          <ErrorState message={detail.error} onRetry={onRetryDetail} />
        ) : !detail.data ? (
          <EmptyState label="Select a topic to view entries." />
        ) : detail.data.entries.length === 0 ? (
          <EmptyState label="No entries in this topic yet." />
        ) : (
          <ul className="space-y-2">
            {detail.data.entries.map((entry, index) => (
              <TopicEntryRow
                key={entry.id}
                index={index + 1}
                entry={entry}
                pending={pendingDeleteEntry === entry.id}
                busy={busy === "delete-entry"}
                onRequestDelete={() => onRequestDeleteEntry(entry.id)}
                onCancelDelete={onCancelDeleteEntry}
                onConfirmDelete={() => onConfirmDeleteEntry(entry.id)}
              />
            ))}
          </ul>
        )}

        {detail.data && detail.data.digest && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/75">
            <Info className="mt-[1px] h-3 w-3 shrink-0 text-white/50" />
            <span className="flex-1 break-words">
              <strong className="font-semibold text-white/85">Digest:</strong> {detail.data.digest}
            </span>
          </div>
        )}

        {detail.data && detail.data.entries.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-violet-400/20 bg-violet-400/10 px-2.5 py-1.5 text-[11px] text-white/90">
            <Lightbulb className="mt-[1px] h-3 w-3 shrink-0 text-violet-300" />
            <span>
              Entries are merged incrementally. Conflicting entries are replaced, not duplicated.
            </span>
          </div>
        )}
      </div>

      {selectedMeta && detail.data && (
        <footer className="shrink-0 border-t border-white/10 bg-white/[0.02] px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[10px] text-white/60">
            <span>Budget</span>
            <span>
              {selectedMeta.charUsage.toLocaleString()} / {selectedMeta.budget.toLocaleString()} chars
            </span>
          </div>
          <BudgetBar usage={selectedMeta.charUsage} limit={selectedMeta.budget} />
        </footer>
      )}
    </section>
  );
}

function TopicEntryRow({
  index,
  entry,
  pending,
  busy,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  index: number;
  entry: TopicEntryView;
  pending: boolean;
  busy: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li className="group relative rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 transition-colors hover:border-white/15 hover:bg-white/[0.05]">
      <div className="flex items-start gap-2">
        <span className="mt-[1px] shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white/70">
          #{index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-white/90">
            {entry.text}
          </p>
          <div className="mt-1 text-[10px] text-white/45">
            Added: {entry.timestamp}
            <span className="ml-1 font-mono text-white/30" title="Entry id">
              · {entry.id}
            </span>
          </div>
        </div>
        {pending ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden text-[10px] text-white/60 sm:inline">Delete?</span>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={busy}
              className="rounded border border-red-400/30 bg-red-400/15 p-1 text-red-200 hover:bg-red-400/25 disabled:opacity-50"
              aria-label="Confirm delete entry"
              title="Confirm delete"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={busy}
              className="rounded border border-white/10 bg-white/[0.05] p-1 text-white/70 hover:bg-white/10 disabled:opacity-50"
              aria-label="Cancel delete entry"
              title="Cancel"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onRequestDelete}
            disabled={busy}
            className="shrink-0 rounded p-1 text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Delete entry"
            title="Delete entry"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </li>
  );
}

function BudgetBar({ usage, limit }: { usage: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
  const tone = pct > 80 ? "danger" : pct >= 50 ? "warning" : "ok";
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={`h-full transition-all ${
          tone === "danger" ? "bg-red-400" : tone === "warning" ? "bg-amber-400" : "bg-emerald-400"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Shared state UI ────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex h-32 items-center justify-center gap-2 text-[11px] text-white/40">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Loading…
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-2 text-center text-[11px] text-white/60">
      <AlertTriangle className="h-4 w-4 text-red-300" />
      <span>Failed to load: {message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/80 hover:bg-white/10"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="flex h-32 items-center justify-center text-[11px] text-white/35">{label}</div>;
}
