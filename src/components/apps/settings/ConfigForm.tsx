"use client";

import { useEffect, useState } from "react";
import type { ConfigField, ConfigOption, ConfigSchemaView } from "@/lib/config/types";

// Generic settings form rendered from a registered config schema. Used for any
// namespace that doesn't provide a custom component.
export function ConfigForm({ schema, onSaved }: { schema: ConfigSchemaView; onSaved?: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(schema.values);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: schema.namespace, values }),
      }).then((r) => r.json());
      setStatus(res.error ? `Error: ${res.error}` : "Saved.");
      if (!res.error) onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {schema.description && <p className="text-xs text-white/50">{schema.description}</p>}
      <div className="grid grid-cols-[140px_1fr] items-center gap-2">
        {schema.fields.map((f) => {
          const val = values[f.key];
          return (
            <FieldRow key={f.key} label={f.label}>
              {f.type === "select" ? (
                <SelectField field={f} value={val} onChange={(v) => set(f.key, v)} />
              ) : f.type === "boolean" ? (
                <input type="checkbox" checked={!!val} onChange={(e) => set(f.key, e.target.checked)} />
              ) : f.type === "textarea" ? (
                <textarea
                  value={String(val ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  rows={4}
                  className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
                />
              ) : (
                <input
                  type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
                  value={String(val ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.secret && schema.secretsSet[f.key] ? "•••••••• (saved — type to replace)" : f.placeholder}
                  className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
                />
              )}
            </FieldRow>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40">
          {saving ? "Saving…" : "Save"}
        </button>
        {status && <span className="text-xs text-white/60">{status}</span>}
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <label className="text-xs text-white/60">{label}</label>
      {children}
    </>
  );
}

// A <select> whose options are either declared inline on the field (static
// enum) or fetched from `field.optionsEndpoint` at render time (dynamic list,
// e.g. plugins whose options depend on external state). Renders "Loading…"
// while fetching and a fallback error option if the fetch fails.
function SelectField({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: string) => void;
}) {
  const [dynamicOptions, setDynamicOptions] = useState<ConfigOption[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">(field.optionsEndpoint ? "loading" : "idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!field.optionsEndpoint) return;
    let cancelled = false;
    fetch(field.optionsEndpoint)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        return body;
      })
      .then((body: unknown) => {
        if (cancelled) return;
        setDynamicOptions(normalizeOptions(body));
        setStatus("idle");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setErrorMsg(err.message || "Failed to load options");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [field.optionsEndpoint]);

  const options = dynamicOptions ?? field.options ?? [];
  const current = String(value ?? "");

  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
    >
      <option value="">
        {status === "loading" ? "Loading…" : status === "error" ? `— ${errorMsg} —` : ""}
      </option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {/* Preserve a previously-saved value that no longer appears in the fetched list. */}
      {current && !options.some((o) => o.value === current) && status !== "loading" && (
        <option value={current}>{current}</option>
      )}
    </select>
  );
}

// Normalize an optionsEndpoint response into ConfigOption[]. Accepted shapes:
//   { options: (string | { value, label })[] }
//   (string | { value, label })[]
function normalizeOptions(body: unknown): ConfigOption[] {
  const raw: unknown = Array.isArray(body)
    ? body
    : (body as { options?: unknown })?.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") return { value: item, label: item };
    if (item && typeof item === "object" && "value" in item) {
      const o = item as { value: unknown; label?: unknown };
      const value = String(o.value);
      return { value, label: typeof o.label === "string" ? o.label : value };
    }
    return { value: String(item), label: String(item) };
  });
}
