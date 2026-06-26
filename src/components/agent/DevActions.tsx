"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { useOSStoreApi } from "@/store/os-provider";
import type { AppManifest } from "@/os/types";

// Extensibility + self-improvement actions: build/install apps via the dev
// harness, and let the agent edit its own instructions and skills.
export function DevActions() {
  const store = useOSStoreApi();

  useCopilotAction({
    name: "buildApp",
    description:
      "Build and install a new BrowserOS app from a natural-language spec using the development harness. The app is installed, added to the dock, and opened.",
    parameters: [
      { name: "spec", type: "string", description: "What the app should do", required: true },
      { name: "name", type: "string", description: "Optional app name", required: false },
      { name: "icon", type: "string", description: "Optional lucide icon name (e.g. Clock, Calculator, Music, ListTodo); auto-chosen if omitted", required: false },
    ],
    handler: async ({ spec, name, icon }) => {
      const res = await fetch("/api/devstudio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, name, icon }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const app = res.app as AppManifest;
      store.getState().registerApp(app);
      store.getState().launch(app.id);
      return `Built and installed "${app.name}" (backend: ${res.source}${res.note ? `, ${res.note}` : ""}). It is now in your dock.`;
    },
  });

  useCopilotAction({
    name: "listInstalledApps",
    description: "List apps that were installed at runtime (not built-in).",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/apps").then((r) => r.json());
      return JSON.stringify((res.apps ?? []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name })));
    },
  });

  useCopilotAction({
    name: "uninstallApp",
    description: "Uninstall a runtime-installed app by id.",
    parameters: [{ name: "id", type: "string", description: "App id", required: true }],
    handler: async ({ id }) => {
      await fetch(`/api/apps?id=${encodeURIComponent(id as string)}`, { method: "DELETE" });
      store.getState().unregisterApp(id as string); // live desktop/dock refresh
      return `Uninstalled ${id} and removed it from the desktop.`;
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
