"use client";

import { useEffect, useRef } from "react";
import { useOSStoreApi } from "@/store/os-provider";
import { fsClient, settingsClient } from "@/lib/os-client";
import { classifyMediaTarget, mediaTargetLabel, proxiedMediaUrl } from "@/lib/apps/media";
import type { AppManifest } from "@/os/types";
import { registerFrontendTool, type FrontendToolHandler } from "@/lib/assistant/client/run-client";
import { elicit } from "@/lib/assistant/client/elicitations";

// Binds the GLOBAL frontend-tool handlers for v2 (declarations live in
// src/lib/assistant/tools/frontend-declarations.ts — single source of truth the
// server registry offers to the model). The server loop dispatches these calls
// to an attached page; the kernel executes them; the result is posted back.
// Mounted once inside AssistantChatV2.
export function FrontendToolsV2(_: { conversationId: string }) {
  const store = useOSStoreApi();
  const htmlViewerIdRef = useRef<string | null>(null);

  useEffect(() => {
    const handlers: Record<string, FrontendToolHandler> = {
      bos_app_launch: async ({ appId }) => {
        const id = store.getState().launch(String(appId ?? ""));
        return id ? `Launched ${appId} (window ${id}).` : `No app with id "${appId}".`;
      },
      bos_app_list: async () =>
        JSON.stringify(
          store
            .getState()
            .apps.filter((a) => !a.hidden)
            .map((a) => ({ id: a.id, name: a.name })),
        ),
      bos_window_close: async ({ windowId }) => {
        store.getState().close(String(windowId ?? ""));
        return `Closed window ${windowId}.`;
      },
      bos_wallpaper_set: async ({ wallpaper }) => {
        store.getState().applySettings({ wallpaper: String(wallpaper ?? "") });
        await settingsClient.patch({ wallpaper: String(wallpaper ?? "") });
        return `Wallpaper set to ${wallpaper}.`;
      },
      bos_browser_open: async ({ url }) => {
        const id = store.getState().launch("browser", { url });
        return id ? `Opened ${url} in the browser.` : "Could not open the browser.";
      },
      ui_preview_open: async () => {
        const id = store.getState().launch("ui-preview");
        return id ? `Opened UI Preview (window ${id}).` : "Could not open UI Preview.";
      },
      web_view: async ({ html, url, filePath, title, update, poster, autoplay, loop, muted }, { conversationId }) => {
        // Scoped to this conversation's active feature branch (see
        // fsClient.rawUrl / api/fs/raw/route.ts) — without this, a mockup or
        // any other file that only exists on an active feature branch's
        // worktree (e.g. under /Specs, /Docs) would silently 404 here even
        // though file_read/file_write (which DO carry this scope) can see it.
        const toRawUrl = (p: string) => fsClient.rawUrl(p, conversationId);
        const resolve = (value: string): string =>
          value.startsWith("/") && !value.startsWith("/api/") ? toRawUrl(value) : value;
        const params: Record<string, unknown> = {};
        let checkUrl: string | undefined;
        if (typeof html === "string" && html) params.html = html;
        else if (typeof filePath === "string" && filePath) {
          params.url = filePath.startsWith("/") ? toRawUrl(filePath) : filePath;
          checkUrl = params.url as string;
        } else if (typeof url === "string" && url) {
          params.url = resolve(url);
          checkUrl = params.url as string;
        }
        if (typeof title === "string" && title) params.title = title;
        if (!params.html && !params.url) return "Provide either html, filePath, or url.";

        // Verify the target actually resolves before reporting success. The
        // preview iframe (src/apps/html-viewer) has no onError/onLoad handler
        // at all, so a 404 or error JSON just renders silently inside the
        // sandboxed window — without this check, the tool call would report
        // "Opened" even when nothing real is behind the URL, which is exactly
        // what happened for real: a path under /Specs on an unresolved branch
        // scope, reported as a successful open.
        if (checkUrl && checkUrl.startsWith("/api/fs/raw")) {
          try {
            const res = await fetch(checkUrl);
            if (!res.ok) {
              const body = await res.json().catch(() => ({}) as { error?: string });
              return `Could not open preview: ${body.error ?? `HTTP ${res.status}`} for ${checkUrl}. Double-check the path — if it's under /Specs or /Docs, confirm the active feature branch is set for this conversation.`;
            }
          } catch {
            return `Could not open preview: request to ${checkUrl} failed.`;
          }
        }

        // An image/video target swaps the viewer's document iframe for a native
        // <img>/<video> on a neutral stage. Classified HERE, not in the app, so
        // the window is dumb about what it shows and the two handlers (this one
        // and the v1 action in OSActions.tsx) share one classifier. A non-media
        // target falls through with params untouched.
        const target = typeof params.url === "string" ? params.url : "";
        const mode = target ? classifyMediaTarget(target) : null;
        if (mode) {
          delete params.url;
          params.mode = mode;
          // An EXTERNAL target is re-served through /api/media-proxy so the
          // element is same-origin — otherwise an http:// LAN endpoint is killed
          // as mixed content on an HTTPS BOS page before it ever requests a
          // byte. Classification and the title above read the ORIGINAL target;
          // only what the element fetches changes.
          params.src = proxiedMediaUrl(target);
          // The titlebar carries the filename unless the agent named the window.
          if (!params.title) params.title = mediaTargetLabel(target);
          // A poster is a media target like any other: a VFS path has to become
          // a raw URL or it 404s in the player, an external one goes through the
          // proxy for the same reason the video does.
          if (typeof poster === "string" && poster) params.poster = proxiedMediaUrl(resolve(poster));
          if (autoplay) params.autoplay = true;
          if (loop) params.loop = true;
          if (muted) params.muted = true;
        }

        if (update && htmlViewerIdRef.current) {
          const stillOpen = store.getState().windows.some((w) => w.id === htmlViewerIdRef.current);
          if (stillOpen) store.getState().close(htmlViewerIdRef.current);
        }
        const id = store.getState().launch("html-viewer", params);
        if (id) htmlViewerIdRef.current = id;
        if (!id) return "Could not open the preview.";
        return mode ? `Opened ${mode} preview (window ${id}).` : `Opened HTML preview (window ${id}).`;
      },
      // Scoped to the dispatching conversation so a write under a branch-coupled
      // mount (/Specs, /Docs) resolves that conversation's active feature branch
      // server-side (see fsClient.scoped in os-client.ts).
      file_list: async ({ path }, { conversationId }) => {
        const entries = await fsClient.scoped(conversationId).list(String(path ?? "") || "/");
        return JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
      },
      file_read: ({ path }, { conversationId }) => fsClient.scoped(conversationId).read(String(path ?? "")),
      file_write: async ({ path, content }, { conversationId }) => {
        await fsClient.scoped(conversationId).write(String(path ?? ""), String(content ?? ""));
        return `Wrote ${path}.`;
      },
      file_mkdir: async ({ path }, { conversationId }) => {
        await fsClient.scoped(conversationId).mkdir(String(path ?? ""));
        return `Created folder ${path}.`;
      },
      file_delete: async ({ path }, { conversationId }) => {
        await fsClient.scoped(conversationId).remove(String(path ?? ""));
        return `Deleted ${path}.`;
      },
      file_rename: async ({ path, to }, { conversationId }) => {
        await fsClient.scoped(conversationId).rename(String(path ?? ""), String(to ?? ""));
        return `Renamed ${path} to ${to}.`;
      },
      // App management: the install/build happen server-side, but the desktop
      // store update (registerApp/launch) is a client effect → frontend tools.
      app_install: async ({ name, html, icon }, { conversationId }) => {
        const res = await fetch("/api/apps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, html, icon, conversationId }),
        }).then((r) => r.json());
        if (res.error) return `Error: ${res.error}`;
        const app = res.app as AppManifest | undefined;
        // A branch install landed in that branch's data clone, NOT here: this
        // version has no system/<id> symlink for it, so registering it would put
        // an entry in the dock whose window cannot load.
        if (res.branch) {
          return `Installed "${app?.name ?? name}" on ${res.branch}. It is not running in this version — build that branch and open its Preview to try it, then promote to make it live.`;
        }
        if (app) {
          store.getState().registerApp(app);
          store.getState().launch(app.id);
        }
        return `Installed "${app?.name ?? name}". It is in your dock and open.`;
      },
      // A staged project can be a multi-facet ITEM (app/, services/, config/),
      // not just an app — res.app is only present if it has an app facet, and
      // res.service is only present if it has a services facet. A services-only
      // item has nothing to launch as a window.
      app_build: async ({ name, dir, entry, icon }, { conversationId }) => {
        const res = await fetch("/api/apps/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, dir, entry, icon, conversationId }),
        }).then((r) => r.json());
        if (res.error) return `Error: ${res.error}`;
        const app = res.app as AppManifest | undefined;
        const service = res.service as { id: string; name: string } | undefined;
        if (res.branch) {
          // Same as app_install: the content is in the branch's clone, so
          // nothing here can run it yet. The service facet was validated but
          // deliberately not started — the branch's preview starts it on boot.
          const built: string[] = [];
          if (app) built.push(`app "${app.name}"`);
          if (service) built.push(`service "${service.name}"`);
          if (built.length === 0) built.push(`item "${name}"`);
          return `Built ${built.join(" + ")} on ${res.branch}. Not running in this version — build that branch and open its Preview to try it, then promote to make it live.`;
        }
        if (app) {
          store.getState().registerApp(app);
          store.getState().launch(app.id);
        }
        const parts: string[] = [];
        if (app) parts.push(`app "${app.name}" (in your dock and open)`);
        if (service) parts.push(`service "${service.name}" (installed and started — manage it from Settings → Plugins → Services)`);
        if (parts.length === 0) parts.push(`item "${name}"`);
        return `Built and installed ${parts.join(" + ")}.`;
      },
      app_list: async () => {
        const res = await fetch("/api/apps").then((r) => r.json());
        const apps = (res.apps ?? []) as { id: string; name: string; status?: string }[];
        return JSON.stringify(apps.map((a) => ({ id: a.id, name: a.name, status: a.status ?? "installed" })));
      },
      app_uninstall: async ({ id }) => {
        const res = await fetch(`/api/apps?id=${encodeURIComponent(String(id ?? ""))}`, { method: "DELETE" }).then((r) => r.json());
        if (res.error) return `Error: ${res.error}`;
        store.getState().unregisterApp(String(id ?? ""));
        return `Uninstalled ${id} (hidden from the desktop; files kept and restorable in Settings → Apps).`;
      },
      // Elicitations: push a blocking card into the transcript and await the
      // user's choice (the kernel's signal withdraws the card on stop).
      // conversationId comes from the dispatch context (run-client.ts), not a
      // ref, so the card always appears in the correct chat even when multiple
      // AssistantChatV2 instances are mounted simultaneously (e.g. Chat + Build Studio).
      agent_request_claude: (input, { signal, conversationId }) => elicit("agent_request_claude", input, conversationId, signal),
      dev_branch_request: (input, { signal, conversationId }) => elicit("dev_branch_request", input, conversationId, signal),
    };
    const unbind = Object.entries(handlers).map(([name, h]) => registerFrontendTool(name, h));
    return () => unbind.forEach((u) => u());
  }, [store]);

  return null;
}
