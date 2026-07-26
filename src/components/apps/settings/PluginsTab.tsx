"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Save } from "lucide-react";
import { ServicesTab, type ServicesTabSelection } from "./ServicesTab";
import { ServiceConfigPanel } from "./ServiceConfigPanel";
import { ServiceLogViewer } from "./ServiceLogViewer";

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
  const dragIdx = useRef<number | null>(null);

  const loadPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/plugins").then((r) => r.json());
      const list: PluginStatus[] = res.plugins ?? [];
      setPlugins(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
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
      await loadPlugins();
    },
    [loadPlugins],
  );

  const reorder = useCallback(
    async (fromIdx: number, toIdx: number) => {
      if (fromIdx === toIdx) return;
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

  const saveConfig = useCallback(
    async (pluginId: string, config: Record<string, unknown>) => {
      await fetch("/api/plugins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId, config }),
      });
      await loadPlugins();
    },
    [loadPlugins],
  );

  const [selectedService, setSelectedService] = useState<ServicesTabSelection | null>(null);
  const selected = plugins.find((p) => p.id === selectedId) ?? null;

  const selectPlugin = (id: string) => {
    setSelectedService(null);
    setSelectedId(id);
  };
  const openServiceConfig = (id: string) => {
    setSelectedId(null);
    setSelectedService({ id, view: "config" });
  };
  const openServiceLogs = (id: string) => {
    setSelectedId(null);
    setSelectedService({ id, view: "logs" });
  };

  if (loading) return <p className="text-xs text-white/40">Loading plugins…</p>;

  return (
    <div className="flex h-full">
      {/* Left: plugin list + services (FR-028 — Services sits below Plugin Pipeline) */}
      <div className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-white/[0.02]">
        <div className="shrink-0 border-b border-white/10 bg-white/5 px-3 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Plugin Pipeline
          </h2>
        </div>
        <div className="p-2">
          {plugins.length === 0 ? (
            <div className="px-2 py-6 text-center">
              <p className="text-xs text-white/40">No plugins installed.</p>
              <p className="mt-1 text-[11px] text-white/25">Install plugins from the Marketplace.</p>
            </div>
          ) : (
            plugins.map((p, idx) => (
              <PluginListItem
                key={p.id}
                plugin={p}
                isSelected={p.id === selectedId}
                onSelect={() => selectPlugin(p.id)}
                onToggle={(active) => void togglePlugin(p.id, active)}
                onDragStart={() => { dragIdx.current = idx; }}
                onDrop={() => {
                  if (dragIdx.current !== null) void reorder(dragIdx.current, idx);
                  dragIdx.current = null;
                }}
              />
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-white/10">
          <ServicesTab selected={selectedService} onOpenConfig={openServiceConfig} onOpenLogs={openServiceLogs} />
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedService ? (
          selectedService.view === "config" ? (
            <div className="min-h-0 flex-1 overflow-auto p-5">
              <ServiceConfigPanel key={selectedService.id} serviceId={selectedService.id} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 p-5">
              <ServiceLogViewer key={selectedService.id} serviceId={selectedService.id} />
            </div>
          )
        ) : selected ? (
          <PluginDetail
            key={selected.id}
            plugin={selected}
            onSaveConfig={(config) => void saveConfig(selected.id, config)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-white/40">
            Select a plugin or service to view its details.
          </div>
        )}
      </div>
    </div>
  );
}

function PluginListItem({
  plugin,
  isSelected,
  onSelect,
  onToggle,
  onDragStart,
  onDrop,
}: {
  plugin: PluginStatus;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: (active: boolean) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onDrop(); }}
      className={`mb-1 flex items-stretch rounded-md border transition-colors ${
        dragOver
          ? "border-violet-400/60 bg-violet-500/10"
          : isSelected
            ? "border-violet-500/70 bg-white/10"
            : "border-transparent hover:border-white/20 hover:bg-white/5"
      }`}
    >
      {/* Drag handle */}
      <div className="flex cursor-grab items-center px-1.5 text-white/20 hover:text-white/40 active:cursor-grabbing">
        <GripVertical size={12} />
      </div>
      <button onClick={onSelect} className="min-w-0 flex-1 py-2 pr-2 text-left">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
            {plugin.manifest.settingsRegistration?.icon ?? "📦"} {plugin.manifest.name}
          </span>
          {/* Toggle badge — stopPropagation so it doesn't also select the row */}
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(!plugin.active);
            }}
            className={`shrink-0 cursor-pointer rounded px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide transition-colors ${
              plugin.active
                ? "bg-green-500/25 text-green-300 hover:bg-green-500/40"
                : "bg-white/10 text-white/40 hover:bg-white/20"
            }`}
          >
            {plugin.active ? "Active" : "Inactive"}
          </span>
        </div>
        <p className="line-clamp-2 text-[11px] leading-snug text-white/50">
          {plugin.manifest.description ?? <span className="italic text-white/30">No description</span>}
        </p>
      </button>
    </div>
  );
}

function PluginDetail({
  plugin,
  onSaveConfig,
}: {
  plugin: PluginStatus;
  onSaveConfig: (config: Record<string, unknown>) => void;
}) {
  const m = plugin.manifest;

  return (
    <div className="overflow-auto p-5">
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-white">{m.name}</h4>
        <p className="mt-0.5 text-[11px] text-white/40">
          v{m.version}
          {m.provides && m.provides.length > 0 && (
            <> · hooks: {m.provides.join(", ")}</>
          )}
        </p>
      </div>

      {m.description && (
        <p className="mb-4 text-xs leading-relaxed text-white/60">{m.description}</p>
      )}

      {plugin.error && (
        <p className="mb-4 rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">{plugin.error}</p>
      )}

      {m.configSchema ? (
        <SchemaConfigForm
          schema={m.configSchema}
          values={plugin.config}
          onSave={onSaveConfig}
        />
      ) : (
        <p className="text-xs italic text-white/30">This plugin has no configurable settings.</p>
      )}
    </div>
  );
}

function SchemaConfigForm({
  schema,
  values,
  onSave,
}: {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
}) {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...values });
  const [saving, setSaving] = useState(false);

  const updateField = (key: string, value: unknown) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try { onSave(draft); } finally { setSaving(false); }
  };

  if (Object.keys(properties).length === 0) return null;

  return (
    <div className="space-y-3">
      <h5 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
        {typeof schema.title === "string" ? schema.title : "Configuration"}
      </h5>
      {Object.entries(properties).map(([key, prop]) => (
        <div key={key} className="space-y-1">
          <label className="block text-xs text-white/60">
            {typeof prop.title === "string" ? prop.title : key}
            {prop.description && (
              <span className="ml-1 text-white/30">— {prop.description}</span>
            )}
          </label>
          {renderField(key, prop, draft[key] ?? prop.default, updateField)}
        </div>
      ))}
      <div className="pt-1">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex items-center gap-1 rounded bg-blue-500/20 px-3 py-1.5 text-xs text-blue-300 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
        >
          <Save size={10} /> {saving ? "Saving…" : "Save"}
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
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  if (prop.type === "boolean") {
    return (
      <button
        onClick={() => onChange(key, !value)}
        className={`flex items-center gap-2 rounded px-2 py-1 text-xs transition-colors ${
          value ? "bg-green-500/20 text-green-300" : "bg-white/5 text-white/40 hover:bg-white/10"
        }`}
      >
        <span className={`inline-block h-3 w-5 rounded-full transition-colors ${value ? "bg-green-400" : "bg-white/20"}`} />
        {value ? "Enabled" : "Disabled"}
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

  return (
    <input
      type="text"
      className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none"
      value={String(value ?? "")}
      onChange={(e) => onChange(key, e.target.value)}
    />
  );
}
