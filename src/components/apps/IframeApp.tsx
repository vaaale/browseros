"use client";

import { useEffect, useRef } from "react";
import { useOSStore } from "@/store/os-provider";
import type { AppCapability } from "@/os/types";
import type { AppProps } from "./types";

// Renders a runtime-installed app in a sandboxed iframe. If the app's manifest
// includes capability grants, a postMessage broker proxies allowed BOS API calls
// from the iframe to the real server APIs. Disallowed calls are rejected.

type BosMessage = {
  __bos_call: true;
  seq: number;
  method: string;
  params: Record<string, unknown>;
};

function isBosMessage(d: unknown): d is BosMessage {
  return (
    typeof d === "object" && d !== null &&
    (d as Record<string, unknown>).__bos_call === true &&
    typeof (d as Record<string, unknown>).seq === "number"
  );
}

const CAP_FOR_METHOD: Record<string, AppCapability> = {
  "fs:list":        "fs:read",
  "fs:read":        "fs:read",
  "fs:write":       "fs:write",
  "fs:delete":      "fs:write",
  "settings:get":   "settings:read",
  "notify":         "notify",
  "window:title":   "window:title",
  "storage:get":    "storage",
  "storage:set":    "storage",
  "storage:remove": "storage",
  "storage:keys":   "storage",
};

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  appId: string,
): Promise<unknown> {
  switch (method) {
    case "fs:list":
      return fetch(`/api/fs?op=list&path=${encodeURIComponent(String(params.path ?? "/"))}`)
        .then((r) => r.json()).then((d) => d.entries);
    case "fs:read":
      return fetch(`/api/fs?op=read&path=${encodeURIComponent(String(params.path ?? "/"))}`)
        .then((r) => r.json()).then((d) => d.content);
    case "fs:write":
      return fetch("/api/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "write", path: params.path, content: params.content }),
      }).then((r) => r.json());
    case "fs:delete":
      return fetch("/api/fs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "delete", path: params.path }),
      }).then((r) => r.json());
    case "settings:get":
      return fetch("/api/settings").then((r) => r.json()).then((d) => d.settings);
    case "notify":
      // Lightweight: post a notification message back to the iframe for display.
      // A full notification system would hook into OS-level toasts.
      return { ok: true, message: params.message };
    case "storage:get":
    case "storage:set":
    case "storage:remove":
    case "storage:keys":
      // Per-app persistent KV (028). The app id comes from the PARENT (trusted
      // BOS code), never the iframe, so an app can't reach another's namespace.
      return fetch("/api/app-storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: appId,
          op: method.slice("storage:".length),
          key: params.key,
          value: params.value,
        }),
      }).then((r) => r.json()).then((d) => d.result);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export function IframeApp({ windowId, appId, params }: AppProps) {
  const url = typeof params?.url === "string" ? params.url : "about:blank";
  const capabilities = params?.capabilities as AppCapability[] | undefined;
  const capSet = new Set<AppCapability>(capabilities ?? []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setTitle = useOSStore((s) => s.setTitle);

  // Untrusted marketplace apps run in an OPAQUE-ORIGIN sandbox (028): dropping
  // allow-same-origin gives the frame a unique throwaway origin, so it cannot
  // reach BOS's origin — the postMessage broker (below) is its only channel, and
  // the SDK's localStorage shim (which activates precisely because native
  // storage is unavailable in an opaque origin) backs storage via that broker.
  // Trusted local/first-party apps keep the same-origin path.
  const untrusted = params?.origin === "marketplace";
  const sandbox = untrusted
    ? "allow-scripts allow-forms allow-popups"
    : "allow-scripts allow-forms allow-popups allow-same-origin";

  useEffect(() => {
    if (!capSet.size) return; // no grants — skip listener entirely

    function handleMessage(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      if (!isBosMessage(e.data)) return;

      const { seq, method, params: msgParams } = e.data;
      const requiredCap = CAP_FOR_METHOD[method];

      const respond = (result: unknown, error?: string) =>
        iframe.contentWindow?.postMessage({ __bos_response: true, seq, result, error }, "*");

      if (!requiredCap || !capSet.has(requiredCap)) {
        respond(null, `Capability "${requiredCap ?? method}" not granted`);
        return;
      }

      if (method === "window:title" && windowId) {
        setTitle(windowId, String(msgParams.title ?? ""));
        respond({ ok: true });
        return;
      }

      dispatch(method, msgParams, appId)
        .then((result) => respond(result))
        .catch((err: Error) => respond(null, err.message));
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, windowId, capabilities?.join(",")]);

  return (
    <iframe
      ref={iframeRef}
      src={url}
      className="h-full w-full border-0 bg-transparent"
      sandbox={sandbox}
      title={`App: ${appId}`}
    />
  );
}
