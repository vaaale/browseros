"use client";

import { useEffect, useRef } from "react";
import { useOSStore } from "@/store/os-provider";
import type { AppCapability } from "@/os/types";
import { getBroker, isAssistantBrokerMethod, releaseBroker, retainBroker } from "./assistant-broker";
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
  "services:config": "services:read",
  "services:status": "services:read",
  "services:call":   "services:read",
  // 040-assistant-broker-capability. All six map to the single "assistant"
  // capability, so the existing synchronous pre-dispatch gate below rejects
  // every one of them at once when the grant is missing (SC-002). Their
  // implementations live in assistant-broker.ts, not dispatch(), because they
  // need per-run state (a live NDJSON tail + an event buffer) that a stateless
  // request/response dispatcher cannot hold.
  "assistant:list-agents":   "assistant",
  "assistant:start-run":     "assistant",
  "assistant:events-attach": "assistant",
  "assistant:tool-result":   "assistant",
  "assistant:active-run":    "assistant",
  "assistant:cancel-run":    "assistant",
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
    case "services:config":
      // Read-only: config values + runtime state (e.g. bound port) for ANY
      // service, not scoped to "this app's own service" — same coarse-grained
      // capability model as fs:read (whole VFS) and settings:read (whole OS
      // settings). This is the ONLY channel an opaque-origin app has to reach
      // /api/services/* (see docs/dev/apps/services.md) — that route has no
      // CORS headers on purpose, so a direct fetch() from the sandboxed
      // iframe fails with a network error; this call runs here, in the
      // trusted parent frame, and relays the result back over postMessage.
      return fetch(`/api/services/${encodeURIComponent(String(params.id ?? ""))}/config`).then((r) => r.json());
    case "services:status":
      // Read-only: `{ service: { state, boundPort, ... } }` for ANY service —
      // same coarse-grained model as services:config above. The status-check
      // counterpart to it (a service's own bundled app polling "is it up?").
      return fetch(`/api/services/${encodeURIComponent(String(params.id ?? ""))}`).then((r) => r.json());
    case "services:call": {
      // The ONLY channel an opaque-origin app has to actually INVOKE a
      // service's own REST bridge (list/create/run/... — not just read its
      // config): resolve the same wsPath/httpPath-if-present-else-direct-port
      // base services:config exposes, then perform the real request HERE, in
      // the trusted same-origin parent frame, and relay the parsed JSON body
      // back over postMessage (docs/dev/apps/services.md §11/§14).
      const id = String(params.id ?? "");
      const subpath = String(params.path ?? "");
      const config = (await fetch(`/api/services/${encodeURIComponent(id)}/config`).then((r) => r.json())) as {
        runtime: { port: number; host: string } | null;
        httpPath: string | null;
      };
      let base: string;
      if (config.httpPath) base = `${window.location.origin}${config.httpPath}`;
      else if (config.runtime?.port) base = `${window.location.protocol}//${window.location.hostname}:${config.runtime.port}/`;
      else throw new Error(`service "${id}" has no bound port yet — is it running?`);
      if (!base.endsWith("/")) base = `${base}/`;
      const url = new URL(subpath.replace(/^\//, ""), base).toString();
      const method = params.method ? String(params.method) : "GET";
      const hasBody = params.body !== undefined;
      const res = await fetch(url, {
        method,
        headers: hasBody ? { "Content-Type": "application/json" } : undefined,
        body: hasBody ? JSON.stringify(params.body) : undefined,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && (body as { error?: string }).error) || `${method} ${subpath}: HTTP ${res.status}`);
      return body;
    }
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

/** 034-event-notification-system (R4/T041): deliver a UI-handler launch's
 *  event reference `{id, type, seq}` to an installed (iframe) app via URL
 *  query params — the one delivery mechanism that works uniformly for both
 *  same-origin and opaque-origin (marketplace) apps with no new broker
 *  protocol. The iframe reads `bosEvent`/`bosEventType`/`bosEventSeq`/
 *  `bosHandler` off `window.location.search` and fetches the full event via
 *  `GET /api/events/:id` (public read) if it needs more than the id/type.
 *  `bos*`-prefixed names avoid colliding with the app's own query params. */
function withEventParams(base: string, params: Record<string, unknown> | undefined): string {
  const event = params?.event as { id?: unknown; type?: unknown; seq?: unknown } | undefined;
  if (!event?.id || typeof window === "undefined") return base;
  try {
    const u = new URL(base, window.location.origin);
    u.searchParams.set("bosEvent", String(event.id));
    if (event.type != null) u.searchParams.set("bosEventType", String(event.type));
    if (event.seq != null) u.searchParams.set("bosEventSeq", String(event.seq));
    if (params?.handler != null) u.searchParams.set("bosHandler", String(params.handler));
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return base;
  }
}

export function IframeApp({ windowId, appId, params }: AppProps) {
  const url = withEventParams(typeof params?.url === "string" ? params.url : "about:blank", params);
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

  // Assistant broker refcount (040). Deliberately its OWN effect keyed only on
  // [appId, windowId]: the message-listener effect below re-runs whenever the
  // capability set changes, and doing the refcount there would tear the app's
  // last-window broker down — killing an in-flight run's tail — the moment the
  // user toggled a permission. Keeping them separate is what makes the spec's
  // "capability revoked mid-run" case behave: in-flight deliveries continue
  // (the run is server-owned) while new calls reject at the gate.
  useEffect(() => {
    retainBroker(appId);
    return () => releaseBroker(appId, windowId);
  }, [appId, windowId]);

  useEffect(() => {
    // Always register the listener, even with zero grants — an app that
    // calls window.__bos before checking what's granted (Terminal does, to
    // read its own service's port) needs an immediate "not granted"
    // rejection. Skipping registration when capSet is empty used to leave
    // such a call with no responder at all, hanging its promise forever
    // instead of rejecting (indistinguishable in the UI from "still loading").
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

      // 040-assistant-broker-capability: assistant methods are stateful (a live
      // per-run NDJSON tail + an event buffer that survives an iframe reload),
      // so they go to the app's module-level broker instead of dispatch(). The
      // push target is resolved LAZILY from the ref: an iframe reload keeps the
      // same element but gets a brand-new contentWindow, and a captured stale
      // one would silently swallow every event afterwards.
      if (isAssistantBrokerMethod(method)) {
        getBroker(appId)
          .handle(method, msgParams, {
            windowId,
            push: (message) => iframeRef.current?.contentWindow?.postMessage(message, "*"),
          })
          .then((result) => respond(result))
          .catch((err: Error) => respond(null, err.message));
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
      className="h-full w-full border-0 bg-black"
      sandbox={sandbox}
      title={`App: ${appId}`}
    />
  );
}
