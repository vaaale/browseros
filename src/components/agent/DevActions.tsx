"use client";

import { useCopilotAction } from "@/components/agent/gated-action";
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
    name: "app_install",
    description:
      "Install a BrowserOS app from a single self-contained index.html document, then add it to the dock and open it. Use this AFTER delegating the build to a Claude developer sub-agent (development tasks must not be hand-written). Pass the HTML the sub-agent produced.",
    parameters: [
      { name: "name", type: "string", description: "App name", required: true },
      { name: "html", type: "string", description: "The complete index.html document (all CSS/JS inline, no external dependencies)", required: true },
      { name: "icon", type: "string", description: "Optional lucide icon name (e.g. Clock, Calculator, Music, ListTodo); auto-chosen if omitted", required: false },
    ],
    handler: async ({ name, html, icon }) => {
      // draft: under the Supervisor the app installs onto the app-candidate
      // branch (previewable; promote/discard from the Topbar) instead of going
      // live immediately. Outside the Supervisor it's a no-op (installs live).
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, html, icon, draft: true }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const app = res.app as AppManifest;
      store.getState().registerApp(app);
      store.getState().launch(app.id);
      return `Installed "${app.name}". It is in your dock and open. If a Supervisor is running, it's a preview on the app-candidate branch — Promote or Discard it from the Topbar.`;
    },
  });

  useCopilotAction({
    name: "app_build",
    description:
      "Install a multi-file app PROJECT (TypeScript/TSX, may import React) that a Claude developer sub-agent authored into a staging directory. Use this for anything beyond a single static HTML file. First delegate to the developer (contentOnly) to WRITE the project into a fresh staging dir with a src/main.tsx (or src/main.ts) entry; then call buildApp with the app name and that directory. The project is bundled with esbuild and installed as a preview (promote/discard from the Topbar).",
    parameters: [
      { name: "name", type: "string", description: "App name", required: true },
      { name: "dir", type: "string", description: "Absolute path of the staging directory the developer wrote the project into (must contain src/main.tsx or src/main.ts)", required: true },
      { name: "entry", type: "string", description: "Build entry relative to dir; defaults to src/main.tsx or src/main.ts", required: false },
      { name: "icon", type: "string", description: "Optional lucide icon name; auto-chosen if omitted", required: false },
    ],
    handler: async ({ name, dir, entry, icon }) => {
      const res = await fetch("/api/apps/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dir, entry, icon }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const app = res.app as AppManifest;
      store.getState().registerApp(app);
      store.getState().launch(app.id);
      return `Built and installed "${app.name}". It's a preview on the app-candidate branch — Promote or Discard from the Topbar.`;
    },
  });

  useCopilotAction({
    name: "app_list",
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
    name: "app_uninstall",
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
    name: "agent_prompt_get",
    description:
      "Read the active agent's EDITABLE base instructions (its personality) — the exact text updateMyInstructions overwrites. This is NOT the fully composed prompt: the always-injected core policy, memory, and skills index are added at runtime and MUST NOT be edited or written back (doing so bakes them into the personality and corrupts the agent).",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/assistant/agent").then((r) => r.json());
      return String(res.activeBody ?? "");
    },
  });

  useCopilotAction({
    name: "agent_prompt_set",
    description:
      "Rewrite the active agent's base instructions (personality) to improve future behavior. Use sparingly and preserve important existing guidance.",
    parameters: [{ name: "instructions", type: "string", description: "The new agent personality instructions", required: true }],
    handler: async ({ instructions }) => {
      const res = await fetch("/api/assistant/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: instructions }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : "Updated the active agent. It takes effect in the next chat session.";
    },
  });

  return null;
}
