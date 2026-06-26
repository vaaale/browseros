"use client";

import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { useOSStore, useOSStoreApi } from "@/store/os-provider";
import { fsClient, settingsClient } from "@/lib/os-client";
import { WALLPAPERS } from "@/os/wallpapers";

// Registers the OS capabilities the agent can invoke. Rendered inside both the
// OSProvider (store access) and the CopilotKit provider (action registration).
export function OSActions() {
  const store = useOSStoreApi();
  const apps = useOSStore((s) => s.apps);
  const windows = useOSStore((s) => s.windows);
  const settings = useOSStore((s) => s.settings);

  useCopilotReadable({
    description: "Current BrowserOS state: installed apps, open windows, and settings.",
    value: {
      apps: apps.map((a) => ({ id: a.id, name: a.name })),
      windows: windows.map((w) => ({ id: w.id, app: w.appId, title: w.title, minimized: w.minimized })),
      wallpaper: settings.wallpaper,
      wallpaperPresets: WALLPAPERS.map((w) => w.id),
    },
  });

  useCopilotAction({
    name: "launchApp",
    description: "Open an application window. Use listApps to discover available app ids.",
    parameters: [
      { name: "appId", type: "string", description: "The app id, e.g. files, browser, settings, chat", required: true },
    ],
    handler: async ({ appId }) => {
      const id = store.getState().launch(appId as string);
      return id ? `Launched ${appId} (window ${id}).` : `No app with id "${appId}".`;
    },
  });

  useCopilotAction({
    name: "listApps",
    description: "List installed applications and their ids.",
    parameters: [],
    handler: async () => JSON.stringify(store.getState().apps.map((a) => ({ id: a.id, name: a.name }))),
  });

  useCopilotAction({
    name: "closeWindow",
    description: "Close an open window by its id.",
    parameters: [{ name: "windowId", type: "string", description: "The window id", required: true }],
    handler: async ({ windowId }) => {
      store.getState().close(windowId as string);
      return `Closed window ${windowId}.`;
    },
  });

  useCopilotAction({
    name: "changeWallpaper",
    description:
      "Change the desktop wallpaper. Accepts a preset id (aurora, dusk, sunset, ocean, forest, graphite, mono), an image URL, or a VFS image path like /Pictures/bg.png.",
    parameters: [{ name: "wallpaper", type: "string", description: "Preset id, URL, or VFS path", required: true }],
    handler: async ({ wallpaper }) => {
      store.getState().applySettings({ wallpaper: wallpaper as string });
      await settingsClient.patch({ wallpaper: wallpaper as string });
      return `Wallpaper set to ${wallpaper}.`;
    },
  });

  useCopilotAction({
    name: "openWebPage",
    description: "Open a URL in the BrowserOS web browser.",
    parameters: [{ name: "url", type: "string", description: "The URL or search query", required: true }],
    handler: async ({ url }) => {
      const id = store.getState().launch("browser", { url });
      return id ? `Opened ${url} in the browser.` : "Could not open the browser.";
    },
  });

  useCopilotAction({
    name: "listFiles",
    description:
      "List entries in the USER'S virtual file system (their Documents, Pictures, Desktop, etc.). This is sandboxed user data — it does NOT contain BrowserOS's own source code, apps, or Settings pages. To change BrowserOS itself, delegate to the developer sub-agent (see the 'Modify BrowserOS' skill); do not hunt for source here.",
    parameters: [{ name: "path", type: "string", description: 'Directory path, defaults to "/"', required: false }],
    handler: async ({ path }) => {
      try {
        const entries = await fsClient.list((path as string) || "/");
        return JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  useCopilotAction({
    name: "readFile",
    description: "Read a text file from the user's virtual file system (sandboxed user data, NOT BrowserOS source code).",
    parameters: [{ name: "path", type: "string", description: "File path", required: true }],
    handler: async ({ path }) => {
      try {
        return await fsClient.read(path as string);
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  useCopilotAction({
    name: "writeFile",
    description:
      "Create or overwrite a text file in the user's virtual file system (sandboxed user data, NOT BrowserOS source code). To modify BrowserOS itself, delegate to the developer sub-agent instead.",
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "content", type: "string", description: "File contents", required: true },
    ],
    handler: async ({ path, content }) => {
      try {
        await fsClient.write(path as string, (content as string) ?? "");
        return `Wrote ${path}.`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  useCopilotAction({
    name: "createFolder",
    description: "Create a directory in the virtual file system.",
    parameters: [{ name: "path", type: "string", description: "Directory path", required: true }],
    handler: async ({ path }) => {
      try {
        await fsClient.mkdir(path as string);
        return `Created folder ${path}.`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  useCopilotAction({
    name: "deletePath",
    description: "Delete a file or folder from the virtual file system.",
    parameters: [{ name: "path", type: "string", description: "Path to delete", required: true }],
    handler: async ({ path }) => {
      try {
        await fsClient.remove(path as string);
        return `Deleted ${path}.`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  return null;
}
