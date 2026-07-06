"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, PlayCircle, Trash2, X } from "lucide-react";

// Offline queue viewer for the Telegram bot service.
//
// Renders every entry from `/api/integrations/telegram/bot/queue` with its
// method, attempts, next retry time, and last error. Buttons: flush now,
// clear all, remove one. The scheduler flushes opportunistically on every
// poll tick — this section is for humans who want the details.

interface QueuedSend {
  id: string;
  method: string;
  payload: Record<string, unknown>;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface QueueResponse {
  entries: QueuedSend[];
}

interface FlushResponse extends QueueResponse {
  sent?: number;
  dropped?: number;
  deferred?: number;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function summarisePayload(entry: QueuedSend): string {
  const chat = entry.payload.chat_id;
  const text = entry.payload.text as string | undefined;
  const parts: string[] = [];
  if (chat !== undefined) parts.push(`→ ${String(chat)}`);
  if (text) parts.push(text.length > 40 ? `${text.slice(0, 40)}…` : text);
  else if (entry.payload.photo) parts.push("photo");
  else if (entry.payload.document) parts.push("document");
  return parts.join("  ");
}

export interface TelegramQueueSectionProps {
  /** Refresh the outer integration list when the queue is flushed / cleared. */
  onChange?: () => void | Promise<void>;
}

export function TelegramQueueSection({ onChange }: TelegramQueueSectionProps) {
  const [entries, setEntries] = useState<QueuedSend[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [flushInfo, setFlushInfo] = useState<
    { sent?: number; dropped?: number; deferred?: number } | undefined
  >();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/telegram/bot/queue");
      const body = (await res.json()) as QueueResponse;
      setEntries(body.entries ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const flush = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setFlushInfo(undefined);
    try {
      const res = await fetch("/api/integrations/telegram/bot/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "flush" }),
      });
      const body = (await res.json()) as FlushResponse;
      if (!res.ok) throw new Error(`Flush failed: HTTP ${res.status}`);
      setEntries(body.entries ?? []);
      setFlushInfo({ sent: body.sent, dropped: body.dropped, deferred: body.deferred });
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  const clear = useCallback(async () => {
    if (!confirm("Discard every queued Telegram send? This cannot be undone.")) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/integrations/telegram/bot/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      if (!res.ok) throw new Error(`Clear failed: HTTP ${res.status}`);
      setEntries([]);
      await onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  const removeEntry = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(undefined);
      try {
        const res = await fetch("/api/integrations/telegram/bot/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove", id }),
        });
        const body = (await res.json()) as QueueResponse;
        if (!res.ok) throw new Error(`Remove failed: HTTP ${res.status}`);
        setEntries(body.entries ?? []);
        await onChange?.();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
          Offline queue{" "}
          <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/60">
            {entries.length}
          </span>
        </h4>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={flush}
            disabled={busy || entries.length === 0}
            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <PlayCircle size={12} /> Flush now
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={busy || entries.length === 0}
            className="inline-flex items-center gap-1.5 rounded border border-red-400/40 px-2 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-40"
          >
            <Trash2 size={12} /> Clear all
          </button>
        </div>
      </div>

      {flushInfo && (
        <div className="mb-2 rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
          Flushed: {flushInfo.sent ?? 0} sent, {flushInfo.dropped ?? 0} dropped,{" "}
          {flushInfo.deferred ?? 0} retried later.
        </div>
      )}
      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <p className="text-[11px] text-white/40">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded border border-white/10 bg-white/[0.03] p-3 text-[11px] text-white/40">
          The queue is empty. Sends that fail transiently (network down, 5xx from Telegram) will
          appear here and retry with exponential backoff on the next poll tick.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-3 border-b border-white/5 px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">
                    {entry.method}
                  </span>
                  <span className="truncate text-[11px] text-white/70">
                    {summarisePayload(entry)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-white/40">
                  <span>Queued {formatTime(entry.queuedAt)}</span>
                  <span>Attempts {entry.attempts}</span>
                  <span>Next retry {formatTime(entry.nextAttemptAt)}</span>
                </div>
                {entry.lastError && (
                  <div className="mt-1 text-[10px] text-red-300/80">{entry.lastError}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeEntry(entry.id)}
                disabled={busy}
                aria-label="Remove entry"
                className="rounded p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-red-300 disabled:opacity-40"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
