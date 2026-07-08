"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Brain,
  UserCircle,
  Plus,
  Trash2,
  Check,
  X,
  Info,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Target = "user" | "memory";

// Matches server-side budget accounting in src/lib/agent/memory/curated.ts.
const DELIM = "\n§\n";
const LIMITS: Record<Target, number> = { user: 1200, memory: 2000 };

interface EntriesResponse {
  target: Target;
  entries: string[];
}

interface MemoryResult {
  success: boolean;
  error?: string;
  usage?: string;
}

interface PaneState {
  entries: string[];
  loading: boolean;
  error: string | null;
}

const INITIAL_PANE: PaneState = { entries: [], loading: true, error: null };

export default function ProfileTab() {
  const [userPane, setUserPane] = useState<PaneState>(INITIAL_PANE);
  const [memoryPane, setMemoryPane] = useState<PaneState>(INITIAL_PANE);

  const loadTarget = useCallback(async (target: Target) => {
    const setter = target === "user" ? setUserPane : setMemoryPane;
    setter((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`/api/memory?target=${target}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EntriesResponse;
      setter({ entries: Array.isArray(data.entries) ? data.entries : [], loading: false, error: null });
    } catch (err) {
      setter({ entries: [], loading: false, error: (err as Error).message || "Failed to load entries" });
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void loadTarget("user");
      void loadTarget("memory");
    }, 0);
    return () => clearTimeout(id);
  }, [loadTarget]);

  return (
    <div className="flex h-full flex-col gap-3 text-xs">
      <InfoBanner />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        <Pane
          target="user"
          title="User Profile"
          icon={UserCircle}
          iconClass="text-sky-300"
          state={userPane}
          onReload={() => loadTarget("user")}
        />
        <Pane
          target="memory"
          title="Agent Notes"
          icon={Brain}
          iconClass="text-violet-300"
          state={memoryPane}
          onReload={() => loadTarget("memory")}
        />
      </div>
    </div>
  );
}

function InfoBanner() {
  return (
    <div className="flex shrink-0 items-start gap-2 rounded-md border border-violet-400/20 bg-violet-400/10 px-3 py-2 text-[11px] text-white/90">
      <Info className="mt-[1px] h-3.5 w-3.5 shrink-0 text-violet-300" />
      <span>
        Changes take effect in your <strong className="font-semibold">next conversation</strong>. The current session
        uses a frozen snapshot.
      </span>
    </div>
  );
}

interface PaneProps {
  target: Target;
  title: string;
  icon: LucideIcon;
  iconClass: string;
  state: PaneState;
  onReload: () => void;
}

function Pane({ target, title, icon: Icon, iconClass, state, onReload }: PaneProps) {
  const limit = LIMITS[target];
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const usage = useMemo(() => charCount(state.entries), [state.entries]);
  const pct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
  const budgetTone = pct > 80 ? "danger" : pct >= 50 ? "warning" : "ok";

  const cancelDraft = () => {
    setDrafting(false);
    setDraft("");
    setOpError(null);
  };

  const submitDraft = async () => {
    const content = draft.trim();
    if (!content) return;
    setSubmitting(true);
    setOpError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action: "add", content }),
      });
      const data = (await res.json().catch(() => ({}))) as MemoryResult;
      if (!res.ok || !data.success) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setDraft("");
      setDrafting(false);
      onReload();
    } catch (err) {
      setOpError((err as Error).message || "Failed to add entry");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async (entry: string) => {
    setSubmitting(true);
    setOpError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action: "remove", oldText: entry }),
      });
      const data = (await res.json().catch(() => ({}))) as MemoryResult;
      if (!res.ok || !data.success) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setPendingDelete(null);
      onReload();
    } catch (err) {
      setOpError((err as Error).message || "Failed to delete entry");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/80">{title}</h2>
          <span className="text-[11px] text-white/40">({state.entries.length})</span>
        </div>
        <button
          type="button"
          onClick={() => setDrafting((v) => !v)}
          disabled={state.loading}
          className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Add entry to ${title}`}
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {drafting && (
          <div className="mb-3 rounded-md border border-violet-400/30 bg-violet-400/5 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submitDraft();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelDraft();
                }
              }}
              placeholder={`New ${target === "user" ? "profile" : "note"} entry…`}
              rows={3}
              autoFocus
              className="w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-white/30"
              aria-label={`New ${target === "user" ? "profile" : "notes"} entry`}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] text-white/40">{draft.trim().length} chars</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={cancelDraft}
                  disabled={submitting}
                  className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/80 hover:bg-white/10 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitDraft}
                  disabled={submitting || !draft.trim()}
                  className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {opError && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-200">
            <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
            <span className="flex-1 break-words">{opError}</span>
            <button
              type="button"
              onClick={() => setOpError(null)}
              className="rounded p-0.5 hover:bg-white/10"
              aria-label="Dismiss error"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {state.loading ? (
          <LoadingState />
        ) : state.error ? (
          <ErrorState message={state.error} onRetry={onReload} />
        ) : state.entries.length === 0 ? (
          <EmptyState label={target === "user" ? "No profile entries yet." : "No agent notes yet."} />
        ) : (
          <ul className="space-y-1.5">
            {state.entries.map((entry, i) => (
              <EntryItem
                key={`${i}-${entry.slice(0, 32)}`}
                entry={entry}
                pending={pendingDelete === entry}
                busy={submitting}
                onRequestDelete={() => {
                  setPendingDelete(entry);
                  setOpError(null);
                }}
                onCancelDelete={() => setPendingDelete(null)}
                onConfirmDelete={() => confirmDelete(entry)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="shrink-0 border-t border-white/10 bg-white/[0.02] px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-white/60">
          <span>Budget</span>
          <span>
            {usage.toLocaleString()} / {limit.toLocaleString()} chars
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full transition-all ${
              budgetTone === "danger"
                ? "bg-red-400"
                : budgetTone === "warning"
                  ? "bg-amber-400"
                  : "bg-emerald-400"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </footer>
    </section>
  );
}

function EntryItem({
  entry,
  pending,
  busy,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  entry: string;
  pending: boolean;
  busy: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li className="group rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 transition-colors hover:border-white/15 hover:bg-white/[0.06]">
      <div className="flex items-start gap-2">
        <p className="flex-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/85">{entry}</p>
        {pending ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden text-[10px] text-white/60 sm:inline">Delete?</span>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={busy}
              className="rounded border border-red-400/30 bg-red-400/15 p-1 text-red-200 hover:bg-red-400/25 disabled:opacity-50"
              aria-label="Confirm delete"
              title="Confirm delete"
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={busy}
              className="rounded border border-white/10 bg-white/[0.05] p-1 text-white/70 hover:bg-white/10 disabled:opacity-50"
              aria-label="Cancel delete"
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
            className="rounded p-1 text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Delete entry"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </li>
  );
}

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
  return (
    <div className="flex h-32 items-center justify-center text-[11px] text-white/35">{label}</div>
  );
}

function charCount(entries: string[]): number {
  return entries.length ? entries.join(DELIM).length : 0;
}
