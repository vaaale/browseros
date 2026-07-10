"use client";

import { useEffect, useRef } from "react";
import { useOSStoreApi } from "@/store/os-provider";
import { fsClient, settingsClient } from "@/lib/os-client";
import { registerFrontendTool, type FrontendToolHandler } from "@/lib/assistant/client/run-client";
import { elicit } from "@/lib/assistant/client/elicitations";

// Binds the GLOBAL frontend-tool handlers for v2 (declarations live in
// src/lib/assistant/tools/frontend-declarations.ts — single source of truth the
// server registry offers to the model). The server loop dispatches these calls
// to an attached page; the kernel executes them; the result is posted back.
// Mounted once inside AssistantChatV2.
export function FrontendToolsV2({ conversationId }: { conversationId: string }) {
  const store = useOSStoreApi();
  const htmlViewerIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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
      web_view: async ({ html, url, filePath, title, update }) => {
        const toRawUrl = (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`;
        const resolve = (value: string): string =>
          value.startsWith("/") && !value.startsWith("/api/") ? toRawUrl(value) : value;
        const params: Record<string, unknown> = {};
        if (typeof html === "string" && html) params.html = html;
        else if (typeof filePath === "string" && filePath) params.url = filePath.startsWith("/") ? toRawUrl(filePath) : filePath;
        else if (typeof url === "string" && url) params.url = resolve(url);
        if (typeof title === "string" && title) params.title = title;
        if (!params.html && !params.url) return "Provide either html, filePath, or url.";
        if (update && htmlViewerIdRef.current) {
          const stillOpen = store.getState().windows.some((w) => w.id === htmlViewerIdRef.current);
          if (stillOpen) store.getState().close(htmlViewerIdRef.current);
        }
        const id = store.getState().launch("html-viewer", params);
        if (id) htmlViewerIdRef.current = id;
        return id ? `Opened HTML preview (window ${id}).` : "Could not open the preview.";
      },
      file_list: async ({ path }) => {
        const entries = await fsClient.list(String(path ?? "") || "/");
        return JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
      },
      file_read: ({ path }) => fsClient.read(String(path ?? "")),
      file_write: async ({ path, content }) => {
        await fsClient.write(String(path ?? ""), String(content ?? ""));
        return `Wrote ${path}.`;
      },
      file_mkdir: async ({ path }) => {
        await fsClient.mkdir(String(path ?? ""));
        return `Created folder ${path}.`;
      },
      file_delete: async ({ path }) => {
        await fsClient.remove(String(path ?? ""));
        return `Deleted ${path}.`;
      },
      // Elicitations: push a blocking card into the transcript and await the
      // user's choice (the kernel's signal withdraws the card on stop).
      agent_request_claude: (input, { signal }) => elicit("agent_request_claude", input, conversationIdRef.current, signal),
      dev_branch_request: (input, { signal }) => elicit("dev_branch_request", input, conversationIdRef.current, signal),
    };
    const unbind = Object.entries(handlers).map(([name, h]) => registerFrontendTool(name, h));
    return () => unbind.forEach((u) => u());
  }, [store]);

  return null;
}
