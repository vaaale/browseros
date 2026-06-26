"use client";

import { useCallback, useEffect, useState } from "react";
import { Wrench, Trash2, Loader2, Plug, PlugZap } from "lucide-react";
import type { AppManifest } from "@/os/types";
import { useOSStoreApi } from "@/store/os-provider";
import type { AppProps } from "./types";

interface InstalledApp {
  id: string;
  name: string;
}

export function DevStudio(_props: AppProps) {
  const store = useOSStoreApi();
  const [spec, setSpec] = useState("");
  const [name, setName] = useState("");
  const [building, setBuilding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [harness, setHarness] = useState<{ ok: boolean; tools?: string[]; error?: string; harnessUrl?: string } | null>(null);

  const loadApps = useCallback(async () => {
    const res = await fetch("/api/apps").then((r) => r.json());
    setApps(res.apps ?? []);
  }, []);

  useEffect(() => {
    loadApps();
    fetch("/api/devstudio").then((r) => r.json()).then(setHarness).catch(() => setHarness({ ok: false }));
  }, [loadApps]);

  const build = async () => {
    if (!spec.trim()) return;
    setBuilding(true);
    setStatus(null);
    try {
      const res = await fetch("/api/devstudio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, name: name || undefined }),
      }).then((r) => r.json());
      if (res.error) {
        setStatus(`Error: ${res.error}`);
      } else {
        const app = res.app as AppManifest;
        store.getState().registerApp(app);
        store.getState().launch(app.id);
        setStatus(`Installed "${app.name}" (backend: ${res.source}${res.note ? ` — ${res.note}` : ""}).`);
        setSpec("");
        setName("");
        loadApps();
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBuilding(false);
    }
  };

  const uninstall = async (id: string) => {
    await fetch(`/api/apps?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    store.getState().unregisterApp(id); // live desktop/dock refresh
    loadApps();
  };

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <Wrench size={16} className="text-amber-300" />
        <span className="font-medium">Dev Studio</span>
        <span
          className="ml-auto flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px]"
          title={harness?.harnessUrl}
        >
          {harness?.ok ? (
            <><PlugZap size={12} className="text-emerald-300" /> harness: {harness.tools?.length ?? 0} tools</>
          ) : (
            <><Plug size={12} className="text-white/40" /> harness offline</>
          )}
        </span>
      </div>

      <div className="space-y-2 border-b border-white/10 p-3">
        <p className="text-xs text-white/50">
          Describe an app. BrowserOS builds it via the Claude MCP harness (or a local fallback), installs it, and opens it.
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="App name (optional)"
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />
        <textarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder="e.g. A pomodoro timer with start/pause/reset and a 25-minute countdown."
          rows={4}
          className="w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
        />
        <button
          onClick={build}
          disabled={building || !spec.trim()}
          className="flex items-center gap-2 rounded bg-amber-400/20 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-400/30 disabled:opacity-40"
        >
          {building ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
          {building ? "Building…" : "Build & install"}
        </button>
        {status && <p className="text-xs text-white/70">{status}</p>}
      </div>

      <div className="flex-1 overflow-auto p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Installed apps</h3>
        {apps.length === 0 && <p className="text-xs text-white/40">No apps installed yet.</p>}
        <div className="space-y-1">
          {apps.map((a) => (
            <div key={a.id} className="group flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
              <span className="flex-1 truncate">{a.name}</span>
              <button
                onClick={() => store.getState().launch(a.id)}
                className="rounded px-2 py-0.5 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
              >
                Open
              </button>
              <button onClick={() => uninstall(a.id)} className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white" title="Uninstall">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
