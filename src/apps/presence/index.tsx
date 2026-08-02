"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOSStore } from "@/store/os-provider";
import { useAgentSpeaking } from "@/lib/voice/client/status-store";
import { patchVoiceConfig } from "@/lib/voice/client/config-store";
import type { AppProps } from "@/components/apps/types";

// Host for a voice engine's visual surface (036). BOS owns the lifecycle; the
// surface only renders media and reports what it is doing:
//
//   BOS → surface   connect            mount: start immediately, no Connect button
//                   speaking           the agent started/stopped talking
//   surface → BOS   aspect  {ratio}    intrinsic video shape → window geometry
//                   playing / stopped  media really is rendering → presence lease
//                   error   {message}  give up; audio falls back to the browser
//
// The lease is renewed from HERE rather than by the surface, so a surface cannot
// keep BOS routing audio to it after this window is gone (FR-013).

const RENEW_INTERVAL_MS = 4000;
/** Fraction of viewport height the face occupies. */
const HEIGHT_FRACTION = 0.25;
/** Keep it inside the upper-left quadrant, but off the corner. */
const INSET_FRACTION = 0.08;
const TOPBAR_H = 32;

interface SurfaceMessage {
  type: string;
  pluginId?: string;
  ratio?: number;
  message?: string;
}

export function PresenceApp({ windowId, params }: AppProps) {
  const engineId = typeof params?.engineId === "string" ? params.engineId : "";
  const url = typeof params?.url === "string" ? params.url : "";
  const label = typeof params?.label === "string" ? params.label : "";
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sessionIdRef = useRef<string>("");
  const playingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const speaking = useAgentSpeaking();
  const resize = useOSStore((s) => s.resize);
  const move = useOSStore((s) => s.move);
  const setTitle = useOSStore((s) => s.setTitle);

  useEffect(() => {
    if (windowId && label) setTitle(windowId, label);
  }, [windowId, label, setTitle]);

  const post = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ ...message, pluginId: engineId }, "*");
  }, [engineId]);

  const signal = useCallback(async (state: "open" | "playing" | "stopped" | "closed") => {
    try {
      const res = await fetch("/api/voice/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engineId, state, sessionId: sessionIdRef.current || undefined }),
      }).then((r) => r.json() as Promise<{ sessionId?: string; error?: string }>);
      if (res.sessionId) sessionIdRef.current = res.sessionId;
      if (res.error) setError(res.error);
    } catch { /* a missed renew just lets the lease lapse — the safe direction */ }
  }, [engineId]);

  // Session open for as long as this window exists. The "closed" signal is what
  // makes the engine drop whatever connection it holds, so a closed window can
  // never leave audio routed into the void.
  useEffect(() => {
    if (!engineId) return;
    void signal("open");
    return () => { void signal("closed"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window
  }, [engineId]);

  // Renew while the surface reports it is rendering.
  useEffect(() => {
    const timer = setInterval(() => {
      if (playingRef.current) void signal("playing");
    }, RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [signal]);

  // Size the window from the stream's own shape: height is a fixed fraction of
  // the viewport, width follows the aspect ratio (FR-010).
  const applyAspect = useCallback((ratio: number) => {
    if (!windowId || !Number.isFinite(ratio) || ratio <= 0) return;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const height = Math.round((vh - TOPBAR_H) * HEIGHT_FRACTION);
    const width = Math.round(height * ratio);
    resize(windowId, { width, height }, { exact: true });
    move(windowId, Math.round(vw * INSET_FRACTION), TOPBAR_H + Math.round(vh * INSET_FRACTION));
  }, [windowId, resize, move]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const data = e.data as SurfaceMessage | null;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "bos-surface-ready":
          post({ type: "bos-surface-connect" });
          break;
        case "bos-surface-aspect":
          if (typeof data.ratio === "number") applyAspect(data.ratio);
          break;
        case "bos-surface-playing":
          playingRef.current = true;
          setError(null);
          void signal("playing");
          break;
        case "bos-surface-stopped":
          playingRef.current = false;
          void signal("stopped");
          break;
        case "bos-surface-error":
          playingRef.current = false;
          setError(data.message ?? "The avatar could not start.");
          void signal("stopped");
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, applyAspect, signal]);

  // Forward speaking state so the face can animate while the agent talks.
  useEffect(() => {
    post({ type: "bos-surface-speaking", speaking });
  }, [speaking, post]);

  return (
    <div className="relative h-full w-full bg-black" data-testid="presence-surface">
      {url ? (
        // Same-origin on purpose: this HTML is served by a BOS plugin, and a
        // plugin already runs as trusted server-side code — sandboxing its own
        // page would buy nothing and would block it from reaching its routes.
        <iframe
          ref={iframeRef}
          src={url}
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin"
          title="Assistant presence"
        />
      ) : (
        <p className="p-3 text-xs text-white/50">No presence surface configured.</p>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col justify-end gap-1.5 bg-black/85 p-2.5 text-[11px] text-rose-200">
          <p className="flex-1 overflow-auto">{error}</p>
          <button
            type="button"
            className="shrink-0 rounded bg-white/10 px-2 py-1 text-white/80 hover:bg-white/20"
            onClick={() => void patchVoiceConfig({ voiceOutput: "audio" })}
          >
            Continue with audio only
          </button>
        </div>
      )}
    </div>
  );
}

export default PresenceApp;
