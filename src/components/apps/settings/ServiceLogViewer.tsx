"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

const POLL_MS = 3000;

export interface ServiceLogViewerProps {
  serviceId: string;
}

export function ServiceLogViewer({ serviceId }: ServiceLogViewerProps) {
  const [content, setContent] = useState<string>("");
  // "Clear" hides everything up to this point without touching the log file
  // on disk — anything appended after stays visible on the next poll.
  const [baseline, setBaseline] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/${encodeURIComponent(serviceId)}/logs`);
      const data = (await res.json()) as { content?: string };
      setContent(data.content ?? "");
    } catch {
      /* transient — keep showing the last content */
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    const kickoff = setTimeout(() => void load(), 0);
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      clearTimeout(kickoff);
      clearInterval(poll);
    };
  }, [load]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  const displayed = content.startsWith(baseline) ? content.slice(baseline.length) : content;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h4 className="text-sm font-semibold text-white">Logs</h4>
        <button
          onClick={() => setBaseline(content)}
          title="Clear (viewer only — the log file on disk is untouched)"
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <Trash2 size={11} /> Clear
        </button>
      </div>
      <pre
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/70"
      >
        {loading && !displayed
          ? "Loading…"
          : displayed || <span className="italic text-white/30">No log output yet.</span>}
      </pre>
    </div>
  );
}
