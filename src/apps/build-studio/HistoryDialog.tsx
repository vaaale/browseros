"use client";

// File-history master/detail dialog (037-project-layer, Phase 6 UI): a list
// of every version that touched a file (spanning the whole store, not just
// the currently active branch), a detail pane showing the selected version's
// content, and a "Restore this version" action.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface HistoryEntry {
  hash: string;
  date: string;
  message: string;
}

export function HistoryDialog({ path, onClose, onRestored }: { path: string; onClose: () => void; onRestored: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/specs/history?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d: { history?: HistoryEntry[]; error?: string }) => {
        if (d.error) {
          setError(d.error);
          setEntries([]);
          return;
        }
        setEntries(d.history ?? []);
        if (d.history?.[0]) setSelected(d.history[0].hash);
      })
      .catch(() => {
        setError("Could not load history.");
        setEntries([]);
      });
  }, [path]);

  useEffect(() => {
    if (!selected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- direct response to `selected` changing, not a cascading update
    setLoadingContent(true);
    fetch(`/api/specs/history?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((d: { content?: string }) => setContent(d.content ?? ""))
      .catch(() => setContent("Could not load this version."))
      .finally(() => setLoadingContent(false));
  }, [path, selected]);

  const restore = async () => {
    if (!selected) return;
    setRestoring(true);
    setError("");
    try {
      const r = await fetch("/api/specs/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, ref: selected }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || "Restore failed.");
      onRestored();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  // Portalled to document.body — the window is positioned with a CSS
  // transform (Window.tsx), which would otherwise make `fixed inset-0` size
  // to the window's own bounds instead of the real viewport (see Dialogs.tsx).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex h-[70vh] w-[80vw] max-w-4xl flex-col rounded-lg border border-white/10 bg-[#161821] shadow-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <h3 className="text-sm font-semibold text-white/90">History — {path.split("/").pop()}</h3>
          <button data-testid="history-dialog-close" onClick={onClose} className="rounded px-2 py-1 text-xs text-white/50 hover:bg-white/10">
            Close
          </button>
        </div>
        {error && <p className="px-4 pt-2 text-xs text-red-400">{error}</p>}
        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-auto border-r border-white/10 py-1">
            {entries === null ? (
              <p className="px-3 py-2 text-xs text-white/40">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="px-3 py-2 text-xs text-white/40">No history found for this file.</p>
            ) : (
              entries.map((e) => (
                <button
                  key={e.hash}
                  onClick={() => setSelected(e.hash)}
                  className={`block w-full px-3 py-2 text-left text-xs ${selected === e.hash ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/5"}`}
                >
                  <div className="truncate font-medium">{e.message || "(no message)"}</div>
                  <div className="text-[10px] text-white/40">
                    {new Date(e.date).toLocaleString()} · {e.hash.slice(0, 8)}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {loadingContent ? (
                <p className="text-xs text-white/40">Loading…</p>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs text-white/80">{content}</pre>
              )}
            </div>
            <div className="flex justify-end border-t border-white/10 px-3 py-2">
              <button
                disabled={!selected || restoring}
                onClick={restore}
                className="rounded bg-emerald-500/25 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/40 disabled:opacity-50"
              >
                {restoring ? "Restoring…" : "Restore this version"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
