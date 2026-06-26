"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Home, ExternalLink } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import type { AppProps } from "./types";

const HOME = "https://example.com";

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return HOME;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // No scheme: treat dotted tokens as hosts, everything else as a web search.
  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function proxied(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

export function WebBrowser({ windowId, params }: AppProps) {
  const initial = typeof params?.url === "string" ? normalizeUrl(params.url as string) : HOME;
  const [history, setHistory] = useState<string[]>([initial]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState(initial);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setTitle = useOSStore((s) => s.setTitle);

  const current = history[index];

  useEffect(() => {
    setDraft(current);
    try {
      setTitle(windowId, `Browser — ${new URL(current).hostname}`);
    } catch {
      setTitle(windowId, "Browser");
    }
  }, [current, setTitle, windowId]);

  const go = (rawUrl: string) => {
    const url = normalizeUrl(rawUrl);
    const next = history.slice(0, index + 1);
    next.push(url);
    setHistory(next);
    setIndex(next.length - 1);
  };

  const src = useMemo(() => proxied(current), [current]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/5 px-2 py-1.5">
        <button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className="rounded p-1.5 hover:bg-white/10 disabled:opacity-30" title="Back">
          <ArrowLeft size={16} />
        </button>
        <button onClick={() => setIndex((i) => Math.min(history.length - 1, i + 1))} disabled={index >= history.length - 1} className="rounded p-1.5 hover:bg-white/10 disabled:opacity-30" title="Forward">
          <ArrowRight size={16} />
        </button>
        <button onClick={() => setReloadKey((k) => k + 1)} className="rounded p-1.5 hover:bg-white/10" title="Reload">
          <RotateCw size={16} />
        </button>
        <button onClick={() => go(HOME)} className="rounded p-1.5 hover:bg-white/10" title="Home">
          <Home size={16} />
        </button>
        <form
          onSubmit={(e) => { e.preventDefault(); go(draft); }}
          className="flex flex-1 items-center"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder="Search or enter address"
            className="w-full rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-white/90 outline-none focus:border-white/30"
          />
        </form>
        <a href={current} target="_blank" rel="noreferrer" className="rounded p-1.5 hover:bg-white/10" title="Open original in new tab">
          <ExternalLink size={16} />
        </a>
      </div>
      <iframe
        key={`${src}-${reloadKey}`}
        ref={iframeRef}
        src={src}
        className="min-h-0 flex-1 bg-white"
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        title="Web content"
      />
    </div>
  );
}
