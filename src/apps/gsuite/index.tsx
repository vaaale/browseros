"use client";

import { useEffect, useState } from "react";
import { Mail, Paperclip } from "lucide-react";
import type { AppProps } from "@/components/apps/types";
import { useOSStore } from "@/store/os-provider";

interface EmailPayload {
  from?: string;
  subject?: string;
  snippet?: string;
  date?: string;
  "attachment.name"?: string;
  "attachment.size"?: string;
}

// R5 (no existing email-detail view in BOS to target): a thin detail view
// rendered from the event payload itself, launched by the Event Viewer's UI-
// handler resolution with `params.event = { id, type, seq }` (R4).
export default function GSuiteMail({ windowId, params }: AppProps) {
  const setTitle = useOSStore((s) => s.setTitle);
  const eventRef = params?.event as { id?: string } | undefined;
  const [payload, setPayload] = useState<EmailPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventRef?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/events/${encodeURIComponent(eventRef.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((full: { payload?: EmailPayload } | null) => {
        if (!cancelled) setPayload(full?.payload ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventRef?.id]);

  useEffect(() => {
    if (payload?.subject) setTitle(windowId, payload.subject);
  }, [payload, setTitle, windowId]);

  if (!eventRef?.id) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-xs text-white/40">No email selected.</div>;
  }
  if (loading) {
    return <div className="p-4 text-xs text-white/40">Loading…</div>;
  }
  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-white/40">
        This email event no longer exists.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-white/5 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-200">
          <Mail size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-white">{payload.subject || "(no subject)"}</h2>
          <p className="truncate text-xs text-white/50">{payload.from || "unknown sender"}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm text-white/80">
        {payload.date && <p className="mb-3 text-xs text-white/40">{payload.date}</p>}
        {payload["attachment.name"] && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
            <Paperclip size={13} className="shrink-0" />
            <span className="truncate">{payload["attachment.name"]}</span>
            {payload["attachment.size"] && <span className="text-white/40">({payload["attachment.size"]})</span>}
          </div>
        )}
        <p className="whitespace-pre-wrap leading-relaxed">{payload.snippet || "No preview available."}</p>
      </div>
    </div>
  );
}
