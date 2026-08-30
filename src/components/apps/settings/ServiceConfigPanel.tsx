"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ConfigFileView {
  name: string;
  values: Record<string, unknown>;
}

interface ConfigResponse {
  configFiles: ConfigFileView[];
  runtime: { port: number; host: string } | null;
  readOnly: boolean;
  configSchema: Record<string, unknown> | null;
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

export interface ServiceConfigPanelProps {
  serviceId: string;
}

export function ServiceConfigPanel({ serviceId }: ServiceConfigPanelProps) {
  const [data, setData] = useState<ConfigResponse | null>(null);
  // From manifest.settingsRegistration.configApp, if the service declares one (T028).
  const [configApp, setConfigApp] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, serviceRes] = await Promise.all([
        fetch(`/api/services/${encodeURIComponent(serviceId)}/config`),
        fetch(`/api/services/${encodeURIComponent(serviceId)}`),
      ]);
      setData(configRes.ok ? ((await configRes.json()) as ConfigResponse) : null);
      if (serviceRes.ok) {
        const { service } = (await serviceRes.json()) as {
          service?: { manifest?: { settingsRegistration?: { configApp?: string } } };
        };
        setConfigApp(service?.manifest?.settingsRegistration?.configApp);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const patchFile = useCallback(
    async (file: string, patch: Record<string, unknown>) => {
      await fetch(`/api/services/${encodeURIComponent(serviceId)}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, patch }),
      }).catch(() => undefined);
    },
    [serviceId],
  );

  if (loading) return <p className="text-xs text-white/40">Loading configuration…</p>;
  if (!data) return <p className="text-xs text-red-400">Failed to load configuration.</p>;

  // A service can register its own self-contained HTML config UI
  // (manifest.settingsRegistration.configApp) instead of the generic
  // schema-driven panel below — served same-origin through
  // /api/services/<id>/config-app so it renders as the panel's main content.
  if (configApp) {
    return (
      <iframe
        key={configApp}
        src={`/api/services/${encodeURIComponent(serviceId)}/config-app`}
        title={`${serviceId} configuration`}
        className="h-full min-h-[600px] w-full rounded-md border border-white/10"
      />
    );
  }

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold text-white">Configuration</h4>

      {data.readOnly && (
        <p className="rounded bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
          This service&apos;s config comes from a read-only marketplace source. Adopt it into user-apps to edit.
        </p>
      )}

      {data.runtime && (
        <p className="text-[11px] text-white/40">
          Bound at runtime: {data.runtime.host}:{data.runtime.port}
        </p>
      )}

      {data.configFiles.length === 0 ? (
        <p className="text-xs italic text-white/30">This service has no configuration files.</p>
      ) : (
        data.configFiles.map((file) => (
          <ConfigFileForm
            key={file.name}
            file={file}
            // The manifest's configSchema describes the file that matches the
            // service id (e.g. terminal.json for the "terminal" service);
            // any other files fall back to a generic auto-typed form.
            schema={file.name === serviceId ? data.configSchema : null}
            readOnly={data.readOnly}
            onPatch={(patch) => void patchFile(file.name, patch)}
          />
        ))
      )}
    </div>
  );
}

function ConfigFileForm({
  file,
  schema,
  readOnly,
  onPatch,
}: {
  file: ConfigFileView;
  schema: Record<string, unknown> | null;
  readOnly: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(file.values);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const pending = timers.current;
    return () => {
      Object.values(pending).forEach(clearTimeout);
    };
  }, []);

  const commit = useCallback(
    (key: string, value: unknown, debounceMs: number) => {
      setValues((prev) => ({ ...prev, [key]: value }));
      if (readOnly) return;
      const existing = timers.current[key];
      if (existing) clearTimeout(existing);
      timers.current[key] = setTimeout(() => {
        onPatch({ [key]: value });
        setSavedAt(Date.now());
      }, debounceMs);
    },
    [onPatch, readOnly],
  );

  const properties = (schema?.properties ?? {}) as Record<string, SchemaProperty>;
  const knownKeys = new Set(Object.keys(properties));
  const extraKeys = Object.keys(values).filter((k) => !knownKeys.has(k));

  return (
    <div className="space-y-2 rounded-md border border-white/10 p-3">
      <div className="flex items-center justify-between">
        <h5 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">{file.name}</h5>
        {savedAt !== null && !readOnly && <span className="text-[10px] text-green-300/70">Saved</span>}
      </div>

      {Object.keys(properties).length === 0 && extraKeys.length === 0 && (
        <p className="text-xs italic text-white/30">No fields.</p>
      )}

      {Object.entries(properties).map(([key, prop]) => (
        <Field
          key={key}
          label={typeof prop.title === "string" ? prop.title : key}
          description={prop.description}
          value={values[key] ?? prop.default}
          prop={prop}
          disabled={readOnly}
          onChange={(v, debounceMs) => commit(key, v, debounceMs)}
        />
      ))}

      {extraKeys.map((key) => (
        <Field
          key={key}
          label={key}
          value={values[key]}
          prop={inferProp(values[key])}
          disabled={readOnly}
          onChange={(v, debounceMs) => commit(key, v, debounceMs)}
        />
      ))}
    </div>
  );
}

function inferProp(value: unknown): SchemaProperty {
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: "number" };
  return { type: "string" };
}

function Field({
  label,
  description,
  value,
  prop,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  value: unknown;
  prop: SchemaProperty;
  disabled: boolean;
  onChange: (value: unknown, debounceMs: number) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-white/60">
        {label}
        {description && <span className="ml-1 text-white/30">— {description}</span>}
      </label>
      {renderInput(prop, value, disabled, onChange)}
    </div>
  );
}

function renderInput(
  prop: SchemaProperty,
  value: unknown,
  disabled: boolean,
  onChange: (value: unknown, debounceMs: number) => void,
) {
  if (prop.enum) {
    return (
      <select
        disabled={disabled}
        className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none disabled:opacity-50"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value, 0)}
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
    const enabled = value === true;
    return (
      <button
        disabled={disabled}
        onClick={() => onChange(!enabled, 0)}
        className={`flex items-center gap-2 rounded px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
          enabled ? "bg-green-500/20 text-green-300" : "bg-white/5 text-white/40 hover:bg-white/10"
        }`}
      >
        <span
          className={`inline-block h-3 w-5 rounded-full transition-colors ${enabled ? "bg-green-400" : "bg-white/20"}`}
        />
        {enabled ? "Enabled" : "Disabled"}
      </button>
    );
  }

  if (prop.type === "number") {
    return (
      <input
        type="number"
        disabled={disabled}
        className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none disabled:opacity-50"
        defaultValue={typeof value === "number" ? value : ""}
        min={prop.minimum}
        max={prop.maximum}
        onChange={(e) => {
          const n = e.target.value === "" ? undefined : Number(e.target.value);
          if (n !== undefined && !Number.isNaN(n)) onChange(n, 500);
        }}
      />
    );
  }

  return (
    <input
      type="text"
      disabled={disabled}
      className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white outline-none disabled:opacity-50"
      defaultValue={String(value ?? "")}
      onChange={(e) => onChange(e.target.value, 500)}
    />
  );
}
