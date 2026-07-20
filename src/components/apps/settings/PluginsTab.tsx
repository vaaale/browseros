"use client";

import { useCallback, useEffect, useState } from "react";
import { GripVertical, Settings, Trash2, ToggleLeft, ToggleRight, AlertCircle } from "lucide-react";

interface PluginStatus {
  id: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    provides?: string[];
    settingsRegistration?: { label: string; icon?: string; description?: string };
  };
  active: boolean;
  config: Record<string, unknown>;
  error?: string;
}

export function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/plugins").then((r) => r.json());
      setPlugins(res.plugins ?? []);
    } catch {
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void loadPlugins(), 0);
    return () => clearTimeout(id);
  }, [loadPlugins]);

  const togglePlugin = useCallback(
    async (pluginId: string, active: boolean) => {
      await fetch("/api/plugins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId, active }),
      });
      loadPlugins();
    },
    [loadPlugins],
  );

  const reorder = useCallback(
    async (fromIdx: number, toIdx: number) => {
      const next = [...plugins];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      setPlugins(next);
      await fetch("/api/plugins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: next.map((p) => p.id) }),
      });
    },
    [plugins],
  );

  const uninstall = useCallback(
    async (pluginId: string) => {
      if (!confirm(`Uninstall plugin "${pluginId}"?`)) return;
      await fetch("/api/plugins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId }),
      });
      setSelectedId(null);
      loadPlugins();
    },
    [loadPlugins],
  );

  const selected = plugins.find((p) => p.id === selectedId);

  if (loading) {
    return <p className="text-xs text-white/40">Loading plugins…</p>;
  }

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-white/60">No plugins installed.</p>
        <p className="text-xs text-white/40">
          Plugins extend BOS with optional features. Install them from the Marketplace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-4">
      {/* Plugin list */}
      <div className="flex w-64 flex-col gap-1 overflow-auto">
        {plugins.map((p, idx) => (
          <div
            key={p.id}
            className={`group flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors ${
              selectedId === p.id ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
            }`}
          >
            <button
              className="cursor-grab text-white/30 hover:text-white/60"
              title="Drag to reorder"
              onMouseDown={(e) => {
                e.preventDefault();
                if (idx > 0) reorder(idx, idx - 1);
              }}
            >
              <GripVertical size={12} />
            </button>
            <button className="flex-1 truncate text-left" onClick={() => setSelectedId(p.id)}>
              {p.manifest.settingsRegistration?.icon ?? "📦"} {p.manifest.name}
            </button>
            <button
              onClick={() => togglePlugin(p.id, !p.active)}
              className="shrink-0 text-white/50 hover:text-white/80"
              title={p.active ? "Deactivate" : "Activate"}
            >
              {p.active ? <ToggleRight size={14} className="text-green-400" /> : <ToggleLeft size={14} />}
            </button>
          </div>
        ))}
      </div>

      {/* Detail panel */}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <PluginDetail plugin={selected} onToggle={togglePlugin} onUninstall={uninstall} />
        ) : (
          <p className="py-10 text-center text-xs text-white/40">Select a plugin to view its details.</p>
        )}
      </div>
    </div>
  );
}

function PluginDetail({
  plugin,
  onToggle,
  onUninstall,
}: {
  plugin: PluginStatus;
  onToggle: (id: string, active: boolean) => void;
  onUninstall: (id: string) => void;
}) {
  const m = plugin.manifest;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h4 className="text-sm font-semibold">{m.name}</h4>
        <span className="text-xs text-white/40">v{m.version}</span>
        {plugin.error && (
          <span className="flex items-center gap-1 text-xs text-red-400">
            <AlertCircle size={12} /> {plugin.error}
          </span>
        )}
      </div>

      {m.description && <p className="text-xs text-white/60">{m.description}</p>}

      <div className="text-xs text-white/50">
        <span className="font-medium text-white/70">Provides:</span>{" "}
        {(m.provides ?? []).join(", ") || "none"}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onToggle(plugin.id, !plugin.active)}
          className={`rounded px-3 py-1 text-xs transition-colors ${
            plugin.active ? "bg-white/10 text-white hover:bg-white/20" : "bg-white/5 text-white/50 hover:bg-white/10"
          }`}
        >
          {plugin.active ? "Deactivate" : "Activate"}
        </button>
        <button
          onClick={() => onUninstall(plugin.id)}
          className="flex items-center gap-1 rounded px-3 py-1 text-xs text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 size={12} /> Uninstall
        </button>
      </div>

      {Object.keys(plugin.config).length > 0 && (
        <div className="space-y-1">
          <h5 className="text-xs font-medium text-white/60">Configuration</h5>
          <pre className="max-h-40 overflow-auto rounded bg-white/5 p-2 text-xs text-white/50">
            {JSON.stringify(plugin.config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
