"use client";

import { useRef } from "react";
import { useCopilotReadable, useCopilotAction } from "@copilotkit/react-core";
import { useOSStore, useOSStoreApi } from "@/store/os-provider";
import { fsClient, settingsClient } from "@/lib/os-client";
import { WALLPAPERS } from "@/os/wallpapers";
import { runToolHandler } from "@/lib/agent/tool-kernel";

// Registers the OS capabilities the agent can invoke. Rendered inside both the
// OSProvider (store access) and the CopilotKit provider (action registration).
//
// Every handler — even local/synchronous store calls — runs inside
// runToolHandler (the tool kernel) for a uniform always-settles contract; the
// kernel timeout also bounds the fsClient/settingsClient calls (which have no
// AbortSignal support of their own).
export function OSActions() {
  const store = useOSStoreApi();
  const apps = useOSStore((s) => s.apps);
  const windows = useOSStore((s) => s.windows);
  const settings = useOSStore((s) => s.settings);
  const htmlViewerIdRef = useRef<string | null>(null);

  useCopilotReadable({
    description: "Current BrowserOS state: installed apps, open windows, and settings.",
    value: {
      apps: apps.filter((a) => !a.hidden).map((a) => ({ id: a.id, name: a.name })),
      windows: windows.map((w) => ({ id: w.id, app: w.appId, title: w.title, minimized: w.minimized })),
      wallpaper: settings.wallpaper,
      wallpaperPresets: WALLPAPERS.map((w) => w.id),
    },
  });

  useCopilotAction({
    name: "bos_app_launch",
    description: "Open an application window. Use listApps to discover available app ids.",
    parameters: [
      { name: "appId", type: "string", description: "The app id, e.g. files, browser, settings, chat", required: true },
    ],
    handler: ({ appId }) =>
      runToolHandler("bos_app_launch", async () => {
        const id = store.getState().launch(appId as string);
        return id ? `Launched ${appId} (window ${id}).` : `No app with id "${appId}".`;
      }),
  });

  useCopilotAction({
    name: "bos_app_list",
    description: "List installed applications and their ids.",
    parameters: [],
    handler: () =>
      runToolHandler("bos_app_list", async () =>
        JSON.stringify(
          store
            .getState()
            .apps.filter((a) => !a.hidden)
            .map((a) => ({ id: a.id, name: a.name })),
        ),
      ),
  });

  useCopilotAction({
    name: "bos_window_close",
    description: "Close an open window by its id.",
    parameters: [{ name: "windowId", type: "string", description: "The window id", required: true }],
    handler: ({ windowId }) =>
      runToolHandler("bos_window_close", async () => {
        store.getState().close(windowId as string);
        return `Closed window ${windowId}.`;
      }),
  });

  useCopilotAction({
    name: "bos_wallpaper_set",
    description:
      "Change the desktop wallpaper. Accepts a preset id (aurora, dusk, sunset, ocean, forest, graphite, mono), an image URL, or a VFS image path like /Pictures/bg.png.",
    parameters: [{ name: "wallpaper", type: "string", description: "Preset id, URL, or VFS path", required: true }],
    handler: ({ wallpaper }) =>
      runToolHandler("bos_wallpaper_set", async () => {
        store.getState().applySettings({ wallpaper: wallpaper as string });
        await settingsClient.patch({ wallpaper: wallpaper as string });
        return `Wallpaper set to ${wallpaper}.`;
      }),
  });

  useCopilotAction({
    name: "bos_browser_open",
    description: "Open a URL in the BrowserOS web browser.",
    parameters: [{ name: "url", type: "string", description: "The URL or search query", required: true }],
    handler: ({ url }) =>
      runToolHandler("bos_browser_open", async () => {
        const id = store.getState().launch("browser", { url });
        return id ? `Opened ${url} in the browser.` : "Could not open the browser.";
      }),
  });

  useCopilotAction({
    name: "web_view",
    description:
      "Open a sandboxed HTML preview window. Provide `html` (a full HTML document), `filePath` (an absolute VFS path such as /mockups/file.html), or `url` (a same-origin URL or an absolute VFS path — leading-`/` paths that are not `/api/*` are auto-rewritten to `/api/fs/raw?path=...`). The preview runs with `sandbox=allow-scripts` and cannot reach BrowserOS APIs. Set `update=true` to reuse the existing preview window instead of opening a new one — use this for iterative design where you update an HTML file and want to refresh in place.",
    parameters: [
      { name: "html", type: "string", description: "Full HTML document to render.", required: false },
      {
        name: "url",
        type: "string",
        description:
          "URL to load in the preview iframe. Absolute VFS paths (e.g. /mockups/file.html) are auto-rewritten to /api/fs/raw?path=... ; already-qualified URLs like /api/fs/raw?path=... or https://... are used as-is.",
        required: false,
      },
      {
        name: "filePath",
        type: "string",
        description: "Absolute VFS path to an HTML file (e.g. /mockups/file.html). Auto-rewritten to /api/fs/raw?path=...",
        required: false,
      },
      { name: "title", type: "string", description: "Optional window title.", required: false },
      {
        name: "update",
        type: "boolean",
        description: "If true, close the existing preview window (if still open) and open a new one in its place instead of spawning an additional window. Use for iterative HTML design.",
        required: false,
      },
    ],
    handler: ({ html, url, filePath, title, update }) =>
      runToolHandler("web_view", async () => {
        const toRawUrl = (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`;
        const resolve = (value: string): string => {
          if (value.startsWith("/") && !value.startsWith("/api/")) return toRawUrl(value);
          return value;
        };
        const params: Record<string, unknown> = {};
        if (typeof html === "string" && html) params.html = html;
        else if (typeof filePath === "string" && filePath) {
          params.url = filePath.startsWith("/") ? toRawUrl(filePath) : filePath;
        } else if (typeof url === "string" && url) {
          params.url = resolve(url);
        }
        if (typeof title === "string" && title) params.title = title;
        if (!params.html && !params.url) return "Provide either html, filePath, or url.";
        // When update=true, close the previous html-viewer window if it is still open.
        if (update && htmlViewerIdRef.current) {
          const stillOpen = store.getState().windows.some((w) => w.id === htmlViewerIdRef.current);
          if (stillOpen) store.getState().close(htmlViewerIdRef.current);
        }
        const id = store.getState().launch("html-viewer", params);
        if (id) htmlViewerIdRef.current = id;
        return id ? `Opened HTML preview (window ${id}).` : "Could not open the preview.";
      }),
  });

  useCopilotAction({
    name: "file_list",
    description:
      "List entries in the USER'S virtual file system (their Documents, Pictures, Desktop, etc.). This is sandboxed user data — it does NOT contain BrowserOS's own source code, apps, or Settings pages. To change BrowserOS itself, delegate to the developer sub-agent (see the 'Modify BrowserOS' skill); do not hunt for source here.",
    parameters: [{ name: "path", type: "string", description: 'Directory path, defaults to "/"', required: false }],
    handler: ({ path }) =>
      runToolHandler("file_list", async () => {
        const entries = await fsClient.list((path as string) || "/");
        return JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
      }),
  });

  useCopilotAction({
    name: "file_read",
    description: "Read a text file from the user's virtual file system (sandboxed user data, NOT BrowserOS source code).",
    parameters: [{ name: "path", type: "string", description: "File path", required: true }],
    handler: ({ path }) => runToolHandler("file_read", () => fsClient.read(path as string)),
  });

  useCopilotAction({
    name: "file_write",
    description:
      "Create or overwrite a text file in the user's virtual file system (sandboxed user data, NOT BrowserOS source code). To modify BrowserOS itself, delegate to the developer sub-agent instead.",
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "content", type: "string", description: "File contents", required: true },
    ],
    handler: ({ path, content }) =>
      runToolHandler("file_write", async () => {
        await fsClient.write(path as string, (content as string) ?? "");
        return `Wrote ${path}.`;
      }),
  });

  useCopilotAction({
    name: "file_mkdir",
    description: "Create a directory in the virtual file system.",
    parameters: [{ name: "path", type: "string", description: "Directory path", required: true }],
    handler: ({ path }) =>
      runToolHandler("file_mkdir", async () => {
        await fsClient.mkdir(path as string);
        return `Created folder ${path}.`;
      }),
  });

  useCopilotAction({
    name: "file_delete",
    description: "Delete a file or folder from the virtual file system.",
    parameters: [{ name: "path", type: "string", description: "Path to delete", required: true }],
    handler: ({ path }) =>
      runToolHandler("file_delete", async () => {
        await fsClient.remove(path as string);
        return `Deleted ${path}.`;
      }),
  });

  return null;
}
