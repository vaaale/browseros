"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff, VideoOff } from "lucide-react";
import { useOSStore } from "@/store/os-provider";
import { mediaTargetLabel, type MediaType } from "@/lib/apps/media";
import type { AppProps } from "@/components/apps/types";

// Sandboxed preview surface for HTML the agent or apps want to render. Accepts
// either a full HTML document (rendered via iframe srcdoc) or a URL/VFS path
// (rendered via iframe src). No allow-same-origin: previewed content cannot
// reach BrowserOS APIs on the parent origin.
//
// Media targets (params.mode = "image" | "video", classified by the web_view
// handler, never here) instead render as a native <img>/<video> on a neutral
// stage — a raster image or video stream carries no executable code, so the
// iframe buys nothing there while it *costs* the video's native fullscreen
// button. The document path below is untouched by media mode.
export default function HtmlViewer({ windowId, params }: AppProps) {
  const setTitle = useOSStore((s) => s.setTitle);

  const html = typeof params?.html === "string" ? (params.html as string) : "";
  const url = typeof params?.url === "string" ? (params.url as string) : "";
  const title = typeof params?.title === "string" ? (params.title as string) : "";
  const mode = params?.mode === "image" || params?.mode === "video" ? (params.mode as MediaType) : null;
  const src = typeof params?.src === "string" ? (params.src as string) : "";

  useEffect(() => {
    if (title) setTitle(windowId, title);
  }, [title, setTitle, windowId]);

  const iframeProps = useMemo(() => {
    if (html) return { srcDoc: html } as const;
    if (url) return { src: url } as const;
    return { srcDoc: EMPTY_DOC } as const;
  }, [html, url]);

  if (mode && src) {
    return (
      <MediaStage
        mode={mode}
        src={src}
        poster={typeof params?.poster === "string" ? (params.poster as string) : ""}
        autoplay={params?.autoplay === true}
        loop={params?.loop === true}
        muted={params?.muted === true}
      />
    );
  }

  return (
    <iframe
      {...iframeProps}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts"
      title={title || "HTML Preview"}
    />
  );
}

// Image/video presentation: centered and fit-to-frame (object-contain + max
// dimensions re-fit on every window resize) on a neutral stage, so a preview
// looks intentional instead of pinned to the top-left of a white page.
function MediaStage({
  mode,
  src,
  poster,
  autoplay,
  loop,
  muted,
}: {
  mode: MediaType;
  src: string;
  poster: string;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
}) {
  // Tracked as the src that failed, not a bare boolean, so a refresh to a new
  // target clears the error without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // React assigns `muted` as a DOM property rather than an attribute; sync it
  // imperatively so a muted+autoplay video is never seen as unmuted by the
  // browser's autoplay policy and silently blocked.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, src]);

  const fit = "h-auto max-h-full w-auto max-w-full rounded-lg object-contain shadow-2xl";
  const Icon = mode === "video" ? VideoOff : ImageOff;

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#1a1a1a] p-4">
      {failedSrc === src ? (
        <div className="flex flex-col items-center gap-2 px-6 text-center">
          <Icon className="h-8 w-8 text-white/25" />
          <p className="text-sm text-white/70">
            Could not load: <span className="break-all font-mono text-white/50">{mediaTargetLabel(src)}</span>
          </p>
          <p className="text-xs text-white/40">
            The file may be missing, or the browser may not support this {mode === "video" ? "codec" : "image format"}.
          </p>
        </div>
      ) : mode === "image" ? (
        // Keyed on src so a web_view update=true always re-fetches rather than
        // reusing the previously decoded frame.
        // eslint-disable-next-line @next/next/no-img-element
        <img key={src} src={src} alt={mediaTargetLabel(src)} className={fit} onError={() => setFailedSrc(src)} />
      ) : (
        <video
          key={src}
          ref={videoRef}
          src={src}
          poster={poster || undefined}
          controls
          playsInline
          preload="metadata"
          autoPlay={autoplay}
          loop={loop}
          muted={muted}
          className={fit}
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  );
}

const EMPTY_DOC = `<!doctype html><html><body style="font:14px system-ui;color:#666;padding:16px">No content provided.</body></html>`;
