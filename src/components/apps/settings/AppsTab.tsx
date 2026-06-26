"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, RotateCcw, PackageX, ExternalLink, Puzzle } from "lucide-react";
import type { AppManifest } from "@/os/types";
import { useOSStore } from "@/store/os-provider";

interface ManagedApp {
  id: string;
  name: string;
  icon: string;
  status: "installed" | "uninstalled";
}

export function AppsTab() {
  const registerApp = useOSStore((s) => s.registerApp);
  const unregisterApp = useOSStore((s) => s.unregisterApp);
  const launch = useOSStore((s) => s.launch);
  const [apps, setApps] = useState<ManagedApp[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/apps").then((r) => r.json());
    setApps(res.apps ?? []);
  }, []);

  useEffect(() => {
    load();
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
            <Row key={a.id} app={a} busy={busy === a.id}>
              <button
                onClick={() => launch(a.id)}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
              >
                <ExternalLink size={12} /> Open
              </button>
              <button
                onClick={() => uninstall(a.id)}
                disabled={busy === a.id}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-400/15 disabled:opacity-40"
              >
                <PackageX size={12} /> Uninstall
              </button>
            </Row>
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
