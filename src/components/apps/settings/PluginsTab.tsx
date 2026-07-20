"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Settings,
  Trash2,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Save,
  X,
} from "lucide-react";

interface PluginStatus {
  id: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description?: string;
    provides?: string[];
    configSchema?: Record<string, unknown>;
    settingsRegistration?: { label: string; icon?: string; description?: string };
  };
  active: boolean;
  config: Record<string, unknown>;
  error?: string;
}

interface SchemaProperty {
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [configuringId, setConfiguringId] = useState<string | null>(null);

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

  const saveConfig = useCallback(
    async (pluginId: string, config: Record<string, unknown>) => {
      await fetch("/api/plugins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId, config }),
      });
      setConfiguringId(null);
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
              className="text-white/30 hover:text-white/60"
              title="Move up"
              onClick={() => idx > 0 && reorder(idx, idx - 1)}
              disabled={idx === 0}
            >
              <ChevronUp size={12} />
            </button>
            <button
              className="text-white/30 hover:text-white/60"
              title="Move down"
              onClick={() => idx < plugins.length - 1 && reorder(idx, idx + 1)}
              disabled={idx === plugins.length - 1}
            >
              <ChevronDown size={12} />
            </button>
            <button className="flex-1 truncate text-left" onClick={() => setSelectedId(p.id)}>
              {p.manifest.settingsRegistration?.icon ?? "📦"} {p.manifest.name}
            </button>
            {p.manifest.configSchema && p.manifest.settingsRegistration && (
              <button
                onClick={() => {
                  setSelectedId(p.id);
                  setConfiguringId(p.id);
                }}
                className="shrink-0 text-white/40 hover:text-white/70"
                title="Configure"
              >
                <Settings size={12} />
              </button>
            )}
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
          <PluginDetail
            plugin={selected}
            onToggle={togglePlugin}
            onUninstall={uninstall}
            configuringId={configuringId}
            setConfiguringId={setConfiguringId}
            onSaveConfig={saveConfig}
          />
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
  configuringId,
  setConfiguringId,
  onSaveConfig,
}: {
  plugin: PluginStatus;
  onToggle: (id: string, active: boolean) => void;
  onUninstall: (id: string) => void;
  configuringId: string | null;
  setConfiguringId: (id: string | null) => void;
  onSaveConfig: (id: string, config: Record<string, unknown>) => void;
}) {
  const m = plugin.manifest;
  const isConfiguring = configuringId === plugin.id && m.configSchema;

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
        {m.configSchema && m.settingsRegistration && (
          <button
            onClick={() => setConfiguringId(isConfiguring ? null : plugin.id)}
            className="rounded px-3 py-1 text-xs bg-white/5 text-white/50 hover:bg-white/10 transition-colors"
          >
            Configure
          </button>
        )}
        <button
          onClick={() => onUninstall(plugin.id)}
          className="flex items-center gap-1 rounded px-3 py-1 text-xs text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 size={12} /> Uninstall
        </button>
      </div>

      {isConfiguring && m.configSchema ? (
        <SchemaConfigForm
          schema={m.configSchema}
          values={plugin.config}
          onSave={(config) => onSaveConfig(plugin.id, config)}
          onCancel={() => setConfiguringId(null)}
        />
      ) : Object.keys(plugin.config).length > 0 ? (
        <div className="space-y-1">
          <h5 className="text-xs font-medium text-white/60">Configuration</h5>
          <pre className="max-h-40 overflow-auto rounded bg-white/5 p-2 text-xs text-white/50">
            {JSON.stringify(plugin.config, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function SchemaConfigForm({
  schema,
  values,
  onSave,
  onCancel,
}: {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...values });

  const updateField = (key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-3 rounded border border-white/10 bg-white/5 p-3">
      <h5 className="text-xs font-medium text-white/70">
        <Settings size={10} className="mr-1 inline" />
        Configure {typeof schema.title === "string" ? schema.title : "Plugin"}
      </h5>
      {Object.entries(properties).map(([key, prop]) => (
        <div key={key} className="space-y-1">
          <label className="text-xs text-white/50">
            {typeof prop.title === "string" ? prop.title : key}
            {prop.description && <span className="ml-1 text-white/30">— {prop.description}</span>}
          </label>
          {renderField(key, prop, draft[key] ?? prop.default, updateField)}
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave(draft)}
          className="flex items-center gap-1 rounded bg-blue-500/20 px-3 py-1 text-xs text-blue-300 hover:bg-blue-500/30 transition-colors"
        >
          <Save size={10} /> Save
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 rounded bg-white/5 px-3 py-1 text-xs text-white/50 hover:bg-white/10 transition-colors"
        >
          <X size={10} /> Cancel
        </button>
      </div>
    </div>
  );
}

function renderField(
  key: string,
  prop: SchemaProperty,
  value: unknown,
  onChange: (key: string, value: unknown) => void,
) {
  if (prop.enum) {
    return (
      <select
        className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none"
        value={String(value ?? "")}
        onChange={(e) => onChange(key, e.target.value)}
      >
        <option value="">— select —</option>
        {prop.enum.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (prop.type === "boolean") {
    return (
      <button
        onClick={() => onChange(key, !value)}
        className="flex items-center gap-1 text-xs text-white/60 hover:text-white/80"
      >
        {value ? <ToggleRight size={14} className="text-green-400" /> : <ToggleLeft size={14} />}
        {value ? "Yes" : "No"}
      </button>
    );
  }

  if (prop.type === "number") {
    return (
      <input
        type="number"
        className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none"
        value={typeof value === "number" ? value : ""}
        min={prop.minimum}
        max={prop.maximum}
        onChange={(e) => {
          const n = e.target.value === "" ? undefined : Number(e.target.value);
          if (n !== undefined && !Number.isNaN(n)) onChange(key, n);
        }}
      />
    );
  }

  // string (default)
  return (
    <input
      type="text"
      className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none"
      value={String(value ?? "")}
      onChange={(e) => onChange(key, e.target.value)}
    />
  );
}
