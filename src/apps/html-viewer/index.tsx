"use client";

import { useEffect, useMemo } from "react";
import { useOSStore } from "@/store/os-provider";
import type { AppProps } from "@/components/apps/types";

// Sandboxed preview surface for HTML the agent or apps want to render. Accepts
// either a full HTML document (rendered via iframe srcdoc) or a URL/VFS path
// (rendered via iframe src). No allow-same-origin: previewed content cannot
// reach BrowserOS APIs on the parent origin.
export default function HtmlViewer({ windowId, params }: AppProps) {
  const setTitle = useOSStore((s) => s.setTitle);

  const html = typeof params?.html === "string" ? (params.html as string) : "";
  const url = typeof params?.url === "string" ? (params.url as string) : "";
  const title = typeof params?.title === "string" ? (params.title as string) : "";

  useEffect(() => {
    if (title) setTitle(windowId, title);
  }, [title, setTitle, windowId]);

  const iframeProps = useMemo(() => {
    if (html) return { srcDoc: html } as const;
    if (url) return { src: url } as const;
    return { srcDoc: EMPTY_DOC } as const;
  }, [html, url]);

  return (
    <iframe
      {...iframeProps}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts"
      title={title || "HTML Preview"}
    />
  );
}

const EMPTY_DOC = `<!doctype html><html><body style="font:14px system-ui;color:#666;padding:16px">No content provided.</body></html>`;
