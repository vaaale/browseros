"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { useOSStoreApi } from "@/store/os-provider";
import type { AppManifest } from "@/os/types";

// Extensibility + self-improvement actions: install apps from generated HTML,
// and let the agent edit its own instructions and skills. There is no dedicated
// "build" tool — building an app is a development task that goes through the
// standard delegateToSubAgent (Claude developer sub-agent) + installApp flow
// (see the "Build App" skill).
export function DevActions() {
  const store = useOSStoreApi();

  useCopilotAction({
    name: "installApp",
    description:
      "Install a BrowserOS app from a single self-contained index.html document, then add it to the dock and open it. Use this AFTER delegating the build to a Claude developer sub-agent (development tasks must not be hand-written). Pass the HTML the sub-agent produced.",
    parameters: [
      { name: "name", type: "string", description: "App name", required: true },
      { name: "html", type: "string", description: "The complete index.html document (all CSS/JS inline, no external dependencies)", required: true },
      { name: "icon", type: "string", description: "Optional lucide icon name (e.g. Clock, Calculator, Music, ListTodo); auto-chosen if omitted", required: false },
    ],
    handler: async ({ name, html, icon }) => {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, html, icon }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const app = res.app as AppManifest;
      store.getState().registerApp(app);
      store.getState().launch(app.id);
      return `Installed "${app.name}". It is now in your dock and open.`;
    },
  });

  useCopilotAction({
    name: "listInstalledApps",
    description: "List apps that were installed at runtime (not built-in).",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/apps").then((r) => r.json());
      return JSON.stringify(
        (res.apps ?? []).map((a: { id: string; name: string; status?: string }) => ({ id: a.id, name: a.name, status: a.status ?? "installed" })),
      );
    },
  });

  useCopilotAction({
    name: "uninstallApp",
    description:
      "Uninstall a runtime-installed app by id. This hides it from the desktop but keeps its files, so the user can restore it from Settings → Apps (or permanently delete it there with Purge).",
    parameters: [{ name: "id", type: "string", description: "App id", required: true }],
    handler: async ({ id }) => {
      await fetch(`/api/apps?id=${encodeURIComponent(id as string)}`, { method: "DELETE" });
      store.getState().unregisterApp(id as string); // live desktop/dock refresh
      return `Uninstalled ${id} (hidden from the desktop; files kept and restorable in Settings → Apps).`;
    },
  });

  useCopilotAction({
    name: "getMyInstructions",
    description: "Read your own current composed system instructions (active profile + skills).",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/assistant/profile").then((r) => r.json());
      return String(res.composed ?? "");
    },
  });

  useCopilotAction({
    name: "updateMyInstructions",
    description:
      "Rewrite the active profile's base instructions to improve future behavior. Use sparingly and preserve important existing guidance.",
    parameters: [{ name: "instructions", type: "string", description: "The new full profile instructions", required: true }],
    handler: async ({ instructions }) => {
      const res = await fetch("/api/assistant/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: instructions }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : "Updated the active profile. It takes effect in the next chat session.";
    },
  });

  return null;
}
