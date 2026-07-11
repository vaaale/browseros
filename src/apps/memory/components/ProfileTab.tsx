"use client";

import { useCallback, useEffect, useState } from "react";
import {
  UserCircle,
  Check,
  X,
  Info,
  Loader2,
  AlertTriangle,
  BookOpen,
} from "lucide-react";

interface IndexEntry {
  file: string;
  description: string;
}

interface MemoryResponse {
  agentId: string;
  preferences: string;
  index: IndexEntry[];
  topics: string[];
}

interface SetResult {
  success: boolean;
  error?: string;
}

interface LoadState {
  preferences: string;
  index: IndexEntry[];
  loading: boolean;
  error: string | null;
}

const INITIAL: LoadState = { preferences: "", index: [], loading: true, error: null };

export default function ProfileTab({ agentId }: { agentId: string }) {
  const [state, setState] = useState<LoadState>(INITIAL);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`/api/memory?agent=${encodeURIComponent(agentId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MemoryResponse;
      const prefs = typeof data.preferences === "string" ? data.preferences : "";
      setState({
        preferences: prefs,
        index: Array.isArray(data.index) ? data.index : [],
        loading: false,
        error: null,
      });
      setDraft(prefs);
    } catch (err) {
      setState({ preferences: "", index: [], loading: false, error: (err as Error).message || "Failed to load memory" });
    }
  }, [agentId]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const dirty = draft !== state.preferences;

  const save = async () => {
    setSaving(true);
    setOpError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/memory?agent=${encodeURIComponent(agentId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setPreferences", content: draft }),
      });
      const data = (await res.json().catch(() => ({}))) as SetResult;
      if (!res.ok || !data.success) {
        setOpError(data.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setState((prev) => ({ ...prev, preferences: draft }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setOpError((err as Error).message || "Failed to save preferences");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 text-xs">
      <InfoBanner />

      {opError && (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-200">
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        {/* User preferences (editable) */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
          <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/[0.02] px-3 py-2">
            <div className="flex items-center gap-2">
              <UserCircle className="h-3.5 w-3.5 text-sky-300" />
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/80">
                User preferences
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {saved && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300">
                  <Check className="h-3 w-3" />
                  Saved
                </span>
              )}
              <button
                type="button"
                onClick={save}
                disabled={saving || state.loading || !dirty}
                className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Save
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {state.loading ? (
              <LoadingState />
            ) : state.error ? (
              <ErrorState message={state.error} onRetry={load} />
            ) : (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (dirty && !saving) void save();
                  }
                }}
                placeholder="Prose summary of the user's stable preferences…"
                className="h-full min-h-[200px] w-full resize-none rounded border border-white/10 bg-black/30 px-2.5 py-2 text-xs leading-relaxed text-white placeholder-white/30 outline-none focus:border-white/30"
                aria-label="User preferences"
              />
            )}
          </div>

          {!state.loading && !state.error && (
            <footer className="shrink-0 border-t border-white/10 bg-white/[0.02] px-3 py-1.5 text-[10px] text-white/50">
              {draft.length.toLocaleString()} chars
            </footer>
          )}
        </section>

        {/* Memory index (read-only) */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
          <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/[0.02] px-3 py-2">
            <div className="flex items-center gap-2">
              <BookOpen className="h-3.5 w-3.5 text-violet-300" />
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/80">
                Memory index
              </h2>
              <span className="text-[11px] text-white/40">({state.index.length})</span>
            </div>
            <span className="text-[10px] italic text-white/40">Auto-generated</span>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {state.loading ? (
              <LoadingState />
            ) : state.error ? (
              <ErrorState message={state.error} onRetry={load} />
            ) : state.index.length === 0 ? (
              <EmptyState label="No topics indexed yet." />
            ) : (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-white/10 text-left text-[10px] uppercase tracking-wider text-white/50">
                    <th className="px-2 py-1.5 font-semibold">Topic file</th>
                    <th className="px-2 py-1.5 font-semibold">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {state.index.map((row, i) => (
                    <tr
                      key={`${i}-${row.file}`}
                      className="border-b border-white/5 align-top hover:bg-white/[0.03]"
                    >
                      <td className="px-2 py-1.5 font-mono text-[10.5px] text-white/85">{row.file}</td>
                      <td className="px-2 py-1.5 break-words text-white/75">{row.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <footer className="flex shrink-0 items-start gap-2 border-t border-white/10 bg-white/[0.02] px-3 py-1.5 text-[10px] text-white/50">
            <Info className="mt-[1px] h-3 w-3 shrink-0 text-white/40" />
            <span>Derived from topic files — manage topics in the Topics tab.</span>
          </footer>
        </section>
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
