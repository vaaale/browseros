"use client";

import { useState } from "react";
import type { ConfigSchemaView } from "@/lib/config/types";

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
                <select
                  value={String(val ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
                >
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
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
