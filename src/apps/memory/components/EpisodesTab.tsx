"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Archive,
  Check,
  Clock,
  FileText,
  Loader2,
  MessageCircle,
  RefreshCw,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Episode sections are declared in server-only code; the client redefines them
// to render every section (missing bodies show as em-dash placeholders).
const SECTION_HEADERS = [
  "Task & outcome",
  "What worked / what failed",
  "Corrections received",
  "Durable lesson candidates",
  "Profile suggestions",
] as const;
type EpisodeSection = (typeof SECTION_HEADERS)[number];

type EpisodeStatus = "pending" | "consolidated";
type Filter = "all" | "pending" | "consolidated";

interface EpisodeMetaView {
  filename: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  watermark: string;
  skillsUsed: string[];
  status: EpisodeStatus;
  skillCandidates?: string[];
}

interface EpisodeDetail {
  meta: EpisodeMetaView;
  sections: Partial<Record<EpisodeSection, string>>;
  path: string;
}

interface ListState {
  pending: EpisodeMetaView[];
  consolidated: EpisodeMetaView[];
  loading: boolean;
  error: string | null;
}

interface DetailState {
  data: EpisodeDetail | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_LIST: ListState = { pending: [], consolidated: [], loading: true, error: null };
const INITIAL_DETAIL: DetailState = { data: null, loading: false, error: null };

export default function EpisodesTab({ agentId }: { agentId: string }) {
  const agentQ = `agent=${encodeURIComponent(agentId)}`;
  const [list, setList] = useState<ListState>(INITIAL_LIST);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>(INITIAL_DETAIL);
  const [busy, setBusy] = useState<null | "review" | "archive" | "delete">(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setList((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`/api/memory/episodes?${agentQ}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pending?: EpisodeMetaView[]; consolidated?: EpisodeMetaView[] };
      setList({
        pending: Array.isArray(data.pending) ? data.pending : [],
        consolidated: Array.isArray(data.consolidated) ? data.consolidated : [],
        loading: false,
        error: null,
      });
    } catch (err) {
      setList({ pending: [], consolidated: [], loading: false, error: (err as Error).message || "Failed to load episodes" });
    }
  }, [agentQ]);

  const loadDetail = useCallback(async (filename: string) => {
    setDetail({ data: null, loading: true, error: null });
    try {
      const res = await fetch(`/api/memory/episodes/${encodeURIComponent(filename)}?${agentQ}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EpisodeDetail;
      setDetail({ data, loading: false, error: null });
    } catch (err) {
      setDetail({ data: null, loading: false, error: (err as Error).message || "Failed to load episode" });
    }
  }, [agentQ]);

  // Reset selection and reload when the agent (list loader) changes. All state
  // updates are deferred to avoid cascading renders within the effect body.
  useEffect(() => {
    const id = setTimeout(() => {
      setSelected(null);
      setDetail(INITIAL_DETAIL);
      void loadList();
    }, 0);
    return () => clearTimeout(id);
  }, [loadList]);

  const filtered = useMemo<EpisodeMetaView[]>(() => {
    const merged = [...list.pending, ...list.consolidated];
    // Newest first — most recent createdAt at the top.
    merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter === "pending") return merged.filter((e) => e.status === "pending");
    if (filter === "consolidated") return merged.filter((e) => e.status === "consolidated");
    return merged;
  }, [list.pending, list.consolidated, filter]);

  const selectedIndex = useMemo(() => {
    if (!selected) return -1;
    return filtered.findIndex((e) => e.filename === selected);
  }, [filtered, selected]);

  const selectFilename = useCallback(
    (filename: string) => {
      setSelected(filename);
      setConfirmingDelete(false);
      setOpError(null);
      void loadDetail(filename);
    },
    [loadDetail],
  );

  const navigate = useCallback(
    (direction: -1 | 1) => {
      if (selectedIndex < 0 || filtered.length === 0) return;
      const nextIdx = selectedIndex + direction;
      if (nextIdx < 0 || nextIdx >= filtered.length) return;
      selectFilename(filtered[nextIdx].filename);
    },
    [filtered, selectedIndex, selectFilename],
  );

  const reviewNow = useCallback(async () => {
    if (!detail.data) return;
    const convId = detail.data.meta.conversationId;
    setBusy("review");
    setOpError(null);
    try {
      const res = await fetch("/api/assistant/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      await loadList();
      if (selected) await loadDetail(selected);
    } catch (err) {
      setOpError((err as Error).message || "Failed to trigger review");
    } finally {
      setBusy(null);
    }
  }, [detail.data, loadDetail, loadList, selected]);

  const archiveSelected = useCallback(async () => {
    if (!selected) return;
    setBusy("archive");
    setOpError(null);
    try {
      const res = await fetch(`/api/memory/episodes/${encodeURIComponent(selected)}/archive?${agentQ}`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setSelected(null);
      setDetail(INITIAL_DETAIL);
      await loadList();
    } catch (err) {
      setOpError((err as Error).message || "Failed to archive episode");
    } finally {
      setBusy(null);
    }
  }, [agentQ, loadList, selected]);

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    setBusy("delete");
    setOpError(null);
    try {
      const res = await fetch(`/api/memory/episodes/${encodeURIComponent(selected)}?${agentQ}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setConfirmingDelete(false);
      setSelected(null);
      setDetail(INITIAL_DETAIL);
      await loadList();
    } catch (err) {
      setOpError((err as Error).message || "Failed to delete episode");
    } finally {
      setBusy(null);
    }
  }, [agentQ, loadList, selected]);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <ListPane
        list={list}
        filtered={filtered}
        filter={filter}
        onFilterChange={setFilter}
        selected={selected}
        onSelect={selectFilename}
        onReload={loadList}
      />
      <DetailPane
        detail={detail}
        busy={busy}
        opError={opError}
        onDismissError={() => setOpError(null)}
        canNavigatePrev={selectedIndex > 0}
        canNavigateNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1}
        confirmingDelete={confirmingDelete}
        onRequestDelete={() => {
          setConfirmingDelete(true);
          setOpError(null);
        }}
        onCancelDelete={() => setConfirmingDelete(false)}
        onConfirmDelete={deleteSelected}
        onReview={reviewNow}
        onArchive={archiveSelected}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(1)}
        onRetryDetail={() => selected && void loadDetail(selected)}
      />
    </div>
  );
}

// ── Left pane ──────────────────────────────────────────────────────────────

interface ListPaneProps {
  list: ListState;
  filtered: EpisodeMetaView[];
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  selected: string | null;
  onSelect: (filename: string) => void;
  onReload: () => void;
}

function ListPane({ list, filtered, filter, onFilterChange, selected, onSelect, onReload }: ListPaneProps) {
  const counts = {
    all: list.pending.length + list.consolidated.length,
    pending: list.pending.length,
    consolidated: list.consolidated.length,
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-white/70" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/80">Episodes</h2>
          <span className="text-[11px] text-white/40">({counts.all})</span>
        </div>
        <button
          type="button"
          onClick={onReload}
          disabled={list.loading}
          className="rounded-md border border-white/10 bg-white/[0.05] p-1 text-white/70 hover:bg-white/10 disabled:opacity-50"
          aria-label="Reload episodes"
          title="Reload"
        >
          <RefreshCw className={`h-3 w-3 ${list.loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="shrink-0 border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex gap-1">
          <FilterChip label="All" active={filter === "all"} count={counts.all} onClick={() => onFilterChange("all")} />
          <FilterChip
            label="Pending"
            active={filter === "pending"}
            count={counts.pending}
            tone="amber"
            onClick={() => onFilterChange("pending")}
          />
          <FilterChip
            label="Consolidated"
            active={filter === "consolidated"}
            count={counts.consolidated}
            tone="emerald"
            onClick={() => onFilterChange("consolidated")}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.loading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={onReload} />
        ) : filtered.length === 0 ? (
          <EmptyState label={counts.all === 0 ? "No episodes yet." : `No ${filter} episodes.`} />
        ) : (
          <ul className="space-y-1">
            {filtered.map((ep) => (
              <ListRow key={ep.filename} ep={ep} selected={ep.filename === selected} onClick={() => onSelect(ep.filename)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "amber" | "emerald";
  onClick: () => void;
}) {
  const activeTone =
    tone === "amber"
      ? "border-amber-400/40 bg-amber-400/15 text-amber-100"
      : tone === "emerald"
        ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
        : "border-white/20 bg-white/15 text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
        active ? activeTone : "border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/[0.08] hover:text-white"
      }`}
      aria-pressed={active}
    >
      <span>{label}</span>
      <span className="text-[10px] text-white/50">{count}</span>
    </button>
  );
}

function ListRow({ ep, selected, onClick }: { ep: EpisodeMetaView; selected: boolean; onClick: () => void }) {
  const timeLabel = formatTime(ep.createdAt);
  const turnCount = estimateTurns(ep);
  const skillCount = ep.skillsUsed?.length ?? 0;
  const badgeClass =
    ep.status === "pending"
      ? "border-amber-400/40 bg-amber-400/15 text-amber-100"
      : "border-emerald-400/40 bg-emerald-400/15 text-emerald-100";
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
        <div className="mb-1 flex items-start justify-between gap-2">
          <span className="truncate text-[11px] font-medium text-white/90" title={ep.filename}>
            {stripMdExt(ep.filename)}
          </span>
          <span className={`shrink-0 rounded-full border px-1.5 py-[1px] text-[10px] font-medium ${badgeClass}`}>
            {ep.status === "pending" ? "Pending" : "Consolidated"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-white/55">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {timeLabel}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="h-2.5 w-2.5" />
            {turnCount} {turnCount === 1 ? "turn" : "turns"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Wrench className="h-2.5 w-2.5" />
            {skillCount} {skillCount === 1 ? "skill" : "skills"}
          </span>
        </div>
      </button>
    </li>
  );
}

// ── Right pane ─────────────────────────────────────────────────────────────

interface DetailPaneProps {
  detail: DetailState;
  busy: null | "review" | "archive" | "delete";
  opError: string | null;
  onDismissError: () => void;
  canNavigatePrev: boolean;
  canNavigateNext: boolean;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onReview: () => void;
  onArchive: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetryDetail: () => void;
}

function DetailPane({
  detail,
  busy,
  opError,
  onDismissError,
  canNavigatePrev,
  canNavigateNext,
  confirmingDelete,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onReview,
  onArchive,
  onPrev,
  onNext,
  onRetryDetail,
}: DetailPaneProps) {
  const data = detail.data;
  const isConsolidated = data?.meta.status === "consolidated";

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-white/70" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/80">Episode Details</h2>
        </div>
        <div className="flex items-center gap-1">
          <ActionBtn
            icon={RefreshCw}
            label="Review Now"
            onClick={onReview}
            disabled={!data || busy !== null}
            loading={busy === "review"}
            title="Trigger fast loop for this conversation"
          />
          <ActionBtn
            icon={Archive}
            label="Archive"
            onClick={onArchive}
            disabled={!data || !isConsolidated || busy !== null}
            loading={busy === "archive"}
            title={isConsolidated ? "Move to .Archive/" : "Only consolidated episodes can be archived"}
          />
          {confirmingDelete ? (
            <div className="flex items-center gap-1 rounded-md border border-red-400/30 bg-red-400/10 px-1.5 py-1 text-[11px]">
              <span className="hidden text-red-100 sm:inline">Delete?</span>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={busy !== null}
                className="rounded border border-red-400/40 bg-red-400/20 p-0.5 text-red-100 hover:bg-red-400/30 disabled:opacity-50"
                aria-label="Confirm delete"
                title="Confirm delete"
              >
                {busy === "delete" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                disabled={busy !== null}
                className="rounded border border-white/10 bg-white/[0.05] p-0.5 text-white/70 hover:bg-white/10 disabled:opacity-50"
                aria-label="Cancel delete"
                title="Cancel"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <ActionBtn
              icon={Trash2}
              label="Delete"
              onClick={onRequestDelete}
              disabled={!data || busy !== null}
              tone="danger"
              title="Delete this episode"
            />
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

        {detail.loading ? (
          <LoadingState />
        ) : detail.error ? (
          <ErrorState message={detail.error} onRetry={onRetryDetail} />
        ) : !data ? (
          <EmptyState label="Select an episode to view details." />
        ) : (
          <DetailBody data={data} />
        )}
      </div>

      {data && (
        <footer className="flex shrink-0 items-center justify-between border-t border-white/10 bg-white/[0.02] px-3 py-2">
          <button
            type="button"
            onClick={onPrev}
            disabled={!canNavigatePrev || busy !== null}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft className="h-3 w-3" />
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!canNavigateNext || busy !== null}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
            <ArrowRight className="h-3 w-3" />
          </button>
        </footer>
      )}
    </section>
  );
}

function DetailBody({ data }: { data: EpisodeDetail }) {
  const { meta, sections } = data;
  const statusBadge =
    meta.status === "pending"
      ? "border-amber-400/40 bg-amber-400/15 text-amber-100"
      : "border-emerald-400/40 bg-emerald-400/15 text-emerald-100";

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white/95">{stripMdExt(meta.filename)}</h3>
          <span className={`rounded-full border px-1.5 py-[1px] text-[10px] font-medium ${statusBadge}`}>
            {meta.status === "pending" ? "Pending" : "Consolidated"}
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-2">
          <MetaRow label="Conversation" value={meta.conversationId} mono />
          <MetaRow label="Created" value={formatDateTime(meta.createdAt)} />
          <MetaRow label="Updated" value={formatDateTime(meta.updatedAt)} />
          <MetaRow label="Watermark" value={meta.watermark || "—"} mono />
          <MetaRow
            label="Skills Used"
            value={meta.skillsUsed && meta.skillsUsed.length > 0 ? meta.skillsUsed.join(", ") : "—"}
          />
          <MetaRow
            label="Skill Candidates"
            value={
              meta.skillCandidates && meta.skillCandidates.length > 0
                ? meta.skillCandidates.join(", ")
                : "—"
            }
          />
        </dl>
      </div>

      <div className="space-y-3">
        {SECTION_HEADERS.map((header) => (
          <SectionBlock key={header} title={header} body={sections[header]} />
        ))}
      </div>
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-white/50">{label}:</dt>
      <dd className={`min-w-0 flex-1 break-words text-white/85 ${mono ? "font-mono text-[10.5px]" : ""}`}>{value}</dd>
    </div>
  );
}

function SectionBlock({ title, body }: { title: EpisodeSection; body: string | undefined }) {
  const empty = !body || !body.trim();
  return (
    <section className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/60">{title}</h4>
      {empty ? (
        <p className="text-[11px] italic text-white/35">— none —</p>
      ) : (
        <p className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-white/85">{body}</p>
      )}
    </section>
  );
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  loading,
  tone,
  title,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: "danger";
  title?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "border-red-400/30 bg-red-400/10 text-red-100 hover:bg-red-400/20"
      : "border-white/10 bg-white/[0.05] text-white/85 hover:bg-white/10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
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

// ── Helpers ────────────────────────────────────────────────────────────────

function stripMdExt(filename: string): string {
  return filename.replace(/\.md$/, "");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// The backend doesn't yet expose an authoritative turn count, so approximate
// from the watermark when possible. Falls back to zero — the badge still
// renders and stays meaningful once the backend fills it in.
function estimateTurns(ep: EpisodeMetaView): number {
  const wm = ep.watermark?.trim();
  if (!wm) return 0;
  const m = /(\d+)/.exec(wm);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
