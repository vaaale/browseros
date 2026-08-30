"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, PackageX, ExternalLink, Puzzle, ShieldCheck, ChevronDown, ChevronRight } from "lucide-react";
import type { AppManifest, AppCapability } from "@/os/types";
import { useOSStore } from "@/store/os-provider";

const ALL_CAPABILITIES: {
  id: AppCapability;
  label: string;
  description: string;
  /** 040-assistant-broker-capability (ADR-6): a capability the app has to ASK
   *  for in its own app.json before it can be granted. The rows without this
   *  flag are deliberately flat — any app can be given any of them — but
   *  driving the assistant is a stronger trust jump, so its row appears only
   *  where the app declared it (and PUT /api/apps/[id]/capabilities rejects it
   *  otherwise, so this is presentation, not the enforcement point). */
  requiresDeclaration?: boolean;
}[] = [
  { id: "fs:read",       label: "Read files",        description: "Read files from your VFS" },
  { id: "fs:write",      label: "Write files",       description: "Create and modify files in your VFS" },
  { id: "settings:read", label: "Read settings",     description: "Read OS settings (theme, accent, etc.)" },
  { id: "notify",        label: "Notifications",     description: "Send desktop notifications" },
  { id: "window:title",  label: "Set window title",  description: "Update the window title bar" },
  { id: "services:read", label: "Read services",     description: "Read a service's config (e.g. its bound port) — needed by an app bundled with its own service, like Terminal" },
  { id: "assistant",     label: "Assistant",         description: "Drive the BOS assistant — start runs and see the assistant's replies for runs this app starts", requiresDeclaration: true },
];

interface InstalledItemView {
  id: string;
  name: string;
  description: string;
  version?: string;
  facets: string[];
  origin: "local" | "marketplace";
  marketplaceId?: string;
  broken: boolean;
}

interface ManagedApp {
  id: string;
  name: string;
  icon: string;
  status: "installed" | "uninstalled";
  capabilities?: AppCapability[];
  /** What the app's own app.json ASKS for, as opposed to what BOS has granted
   *  (`capabilities`). Only declaration-gated rows consult it (040, ADR-6). */
  declared?: AppCapability[];
  /** Absent/"local" = the user authored it; "marketplace" = its files belong to a marketplace. */
  origin?: "local" | "marketplace";
  marketplaceId?: string;
}

export function AppsTab() {
  const registerApp = useOSStore((s) => s.registerApp);
  const unregisterApp = useOSStore((s) => s.unregisterApp);
  const launch = useOSStore((s) => s.launch);
  const [apps, setApps] = useState<ManagedApp[]>([]);
  /** Installed items that are NOT apps — a voice engine or integration has no
   *  window to open, so nothing else in the UI ever listed it and it looked
   *  uninstalled while being active. */
  const [pluginItems, setPluginItems] = useState<InstalledItemView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadPluginItems = useCallback(async () => {
    const res = await fetch("/api/items").then((r) => r.json()) as { items?: InstalledItemView[] };
    setPluginItems((res.items ?? []).filter((i) => i.facets.includes("plugin") && !i.facets.includes("app")));
  }, []);

  const load = useCallback(async () => {
    void loadPluginItems();
    const res = await fetch("/api/apps").then((r) => r.json());
    const rawApps: ManagedApp[] = res.apps ?? [];
    const withCaps = await Promise.all(
      rawApps.map(async (a) => {
        if (a.status !== "installed") return a;
        const res = await fetch(`/api/apps/${encodeURIComponent(a.id)}/capabilities`)
          .then((r) => r.json() as Promise<{ capabilities?: AppCapability[]; declared?: AppCapability[] }>)
          .catch(() => ({}) as { capabilities?: AppCapability[]; declared?: AppCapability[] });
        return { ...a, capabilities: res.capabilities ?? [], declared: res.declared ?? [] };
      }),
    );
    setApps(withCaps);
  }, [loadPluginItems]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const uninstall = async (id: string) => {
    setBusy(id);
    try {
      await fetch(`/api/apps?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      unregisterApp(id); // live desktop/dock refresh
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggleCap = async (id: string, cap: AppCapability, current: AppCapability[]) => {
    const next = current.includes(cap) ? current.filter((c) => c !== cap) : [...current, cap];
    const res = await fetch(`/api/apps/${encodeURIComponent(id)}/capabilities`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: next }),
    }).then((r) => r.json());
    if (res.app) registerApp(res.app as AppManifest);
    // Trust the SERVER's grant set, not `next`: a declaration-gated capability
    // (040, ADR-6) can come back rejected, and echoing `next` would leave the
    // checkbox ticked for a grant that was never written.
    const granted = (res.app as AppManifest | undefined)?.capabilities ?? next;
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, capabilities: granted } : a)));
  };

  const purge = async (id: string, name: string) => {
    if (!confirm(`Permanently delete "${name}" and its files? This cannot be undone.`)) return;
    setBusy(id);
    try {
      await fetch(`/api/apps?id=${encodeURIComponent(id)}&purge=1`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const uninstallItem = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await fetch("/api/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "uninstall-item", itemId: id }),
      });
      await loadPluginItems();
    } finally {
      setBusy(null);
    }
  }, [loadPluginItems]);

  // Installed state IS the item symlink (035), so every listed app is installed —
  // uninstalling removes it from this list entirely.
  const installed = apps.filter((a) => a.status === "installed");

  return (
    <div className="space-y-6">
      <p className="text-xs text-white/50">
        Apps are built by the assistant, or installed from the Marketplace. Uninstalling removes an app completely — to get it
        back, install it again from the Marketplace. Purge additionally deletes the files, and is only available for apps you
        authored yourself (a marketplace app&apos;s files belong to its marketplace).
      </p>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Installed ({installed.length})</h3>
        {installed.length === 0 && <p className="text-xs text-white/40">No apps installed.</p>}
        <div className="space-y-1">
          {installed.map((a) => (
            <div key={a.id}>
              <Row app={a} busy={busy === a.id}>
                <button
                  onClick={() => launch(a.id)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
                >
                  <ExternalLink size={12} /> Open
                </button>
                <button
                  onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-300 hover:bg-blue-400/15"
                  title="Manage capabilities"
                >
                  <ShieldCheck size={12} />
                  {expanded === a.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <button
                  onClick={() => uninstall(a.id)}
                  disabled={busy === a.id}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-400/15 disabled:opacity-40"
                >
                  <PackageX size={12} /> Uninstall
                </button>
                {a.origin !== "marketplace" && (
                  <button
                    onClick={() => purge(a.id, a.name)}
                    disabled={busy === a.id}
                    title="Delete this app's files permanently"
                    className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15 disabled:opacity-40"
                  >
                    <Trash2 size={12} /> Purge
                  </button>
                )}
              </Row>
              {expanded === a.id && (
                <div className="ml-4 mt-0.5 rounded border border-white/10 bg-white/[0.02] p-3 space-y-2">
                  <p className="text-[10px] text-white/40 mb-2">BOS SDK capability grants — only checked permissions are available to this app.</p>
                  {ALL_CAPABILITIES.filter(
                    (cap) => !cap.requiresDeclaration || (a.declared ?? []).includes(cap.id),
                  ).map((cap) => (
                    <label key={cap.id} className="flex items-start gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-blue-500"
                        checked={a.capabilities?.includes(cap.id) ?? false}
                        onChange={() => toggleCap(a.id, cap.id, a.capabilities ?? [])}
                      />
                      <span className="text-[11px] leading-tight">
                        <span className="text-white/80 font-medium">{cap.label}</span>
                        <span className="text-white/40 ml-1">— {cap.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {pluginItems.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
            Plugins ({pluginItems.length})
          </h3>
          <p className="mb-2 text-[11px] text-white/40">
            Installed from the Marketplace, with no window of their own — a voice engine or an
            integration. Each one configures itself on its own Settings page.
          </p>
          <div className="space-y-1">
            {pluginItems.map((i) => (
              <div
                key={i.id}
                className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
              >
                <Puzzle size={14} className="shrink-0 text-white/40" />
                <span className="flex-1 truncate text-xs">
                  {i.name}
                  {i.version && <span className="ml-1.5 text-white/30">v{i.version}</span>}
                  {i.broken && <span className="ml-1.5 text-red-300">— files missing</span>}
                </span>
                <span className="shrink-0 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300">plugin</span>
                <button
                  onClick={() => void uninstallItem(i.id)}
                  disabled={busy === i.id}
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-400/15 disabled:opacity-40"
                >
                  <PackageX size={12} /> Uninstall
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}

function Row({ app, busy, dim, children }: { app: ManagedApp; busy: boolean; dim?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5 ${
        dim ? "opacity-60" : ""
      } ${busy ? "animate-pulse" : ""}`}
    >
      <Puzzle size={14} className="shrink-0 text-white/40" />
      <span className="flex-1 truncate text-xs">{app.name}</span>
      {children}
    </div>
  );
}
