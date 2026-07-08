"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, RotateCcw, PackageX, ExternalLink, Puzzle, ShieldCheck, ChevronDown, ChevronRight } from "lucide-react";
import type { AppManifest, AppCapability } from "@/os/types";
import { useOSStore } from "@/store/os-provider";

const ALL_CAPABILITIES: { id: AppCapability; label: string; description: string }[] = [
  { id: "fs:read",       label: "Read files",        description: "Read files from your VFS" },
  { id: "fs:write",      label: "Write files",       description: "Create and modify files in your VFS" },
  { id: "settings:read", label: "Read settings",     description: "Read OS settings (theme, accent, etc.)" },
  { id: "notify",        label: "Notifications",     description: "Send desktop notifications" },
  { id: "window:title",  label: "Set window title",  description: "Update the window title bar" },
];

interface ManagedApp {
  id: string;
  name: string;
  icon: string;
  status: "installed" | "uninstalled";
  capabilities?: AppCapability[];
}

export function AppsTab() {
  const registerApp = useOSStore((s) => s.registerApp);
  const unregisterApp = useOSStore((s) => s.unregisterApp);
  const launch = useOSStore((s) => s.launch);
  const [apps, setApps] = useState<ManagedApp[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/apps").then((r) => r.json());
    const rawApps: ManagedApp[] = res.apps ?? [];
    const withCaps = await Promise.all(
      rawApps.map(async (a) => {
        if (a.status !== "installed") return a;
        const caps = await fetch(`/api/apps/${encodeURIComponent(a.id)}/capabilities`)
          .then((r) => r.json()).then((d) => d.capabilities as AppCapability[]).catch(() => []);
        return { ...a, capabilities: caps };
      }),
    );
    setApps(withCaps);
  }, []);

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

  const restore = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/apps?id=${encodeURIComponent(id)}`, { method: "PATCH" }).then((r) => r.json());
      if (res.app) registerApp(res.app as AppManifest); // live desktop/dock refresh
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
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, capabilities: next } : a)));
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

  const installed = apps.filter((a) => a.status === "installed");
  const uninstalled = apps.filter((a) => a.status === "uninstalled");

  return (
    <div className="space-y-6">
      <p className="text-xs text-white/50">
        Apps are built by the assistant and installed into BrowserOS. Uninstalling hides an app but keeps its files so you can
        restore it later; purge deletes the files for good.
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
              </Row>
              {expanded === a.id && (
                <div className="ml-4 mt-0.5 rounded border border-white/10 bg-white/[0.02] p-3 space-y-2">
                  <p className="text-[10px] text-white/40 mb-2">BOS SDK capability grants — only checked permissions are available to this app.</p>
                  {ALL_CAPABILITIES.map((cap) => (
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

      {uninstalled.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Uninstalled ({uninstalled.length})</h3>
          <div className="space-y-1">
            {uninstalled.map((a) => (
              <Row key={a.id} app={a} busy={busy === a.id} dim>
                <button
                  onClick={() => restore(a.id)}
                  disabled={busy === a.id}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-400/15 disabled:opacity-40"
                >
                  <RotateCcw size={12} /> Restore
                </button>
                <button
                  onClick={() => purge(a.id, a.name)}
                  disabled={busy === a.id}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15 disabled:opacity-40"
                >
                  <Trash2 size={12} /> Purge
                </button>
              </Row>
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
