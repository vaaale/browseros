"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";

// Settings → Build Studio: which sub-agent powers the Build Studio app's chat
// (the `build-studio` config namespace, read by the app on mount). This file
// restores a tab that was referenced by src/apps/settings/index.tsx but missing
// from the repo (the import was committed without the component).

interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export function BuildStudioTab() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/subagents").then((r) => r.json()),
    ])
      .then(([cfg, subs]) => {
        const s = (cfg.schemas ?? []).find((x: { namespace: string }) => x.namespace === "build-studio");
        setAgent(String((s?.values as { agent?: string } | undefined)?.agent || "build-studio"));
        setAgents(((subs.subAgents ?? []) as AgentOption[]).map((a) => ({ id: a.id, name: a.name, description: a.description })));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return <p className="text-xs text-white/40">Loading…</p>;

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "build-studio", values: { agent } }),
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const selected = agents.find((a) => a.id === agent);

  return (
    <div className="max-w-xl space-y-4 text-xs">
      <p className="text-white/50">
        The sub-agent that powers the <b>Build Studio</b> chat (spec authoring). The app reads this on
        mount; open windows pick up a change after a reload.
      </p>

      <label className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-white/60">Agent</span>
        <select
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            setSaved(false);
          }}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
        >
          {!agents.some((a) => a.id === agent) && <option value={agent}>{agent}</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      {selected?.description && <p className="pl-[128px] text-white/40">{selected.description}</p>}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 hover:bg-white/20 disabled:opacity-40"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} className="text-emerald-300" /> : <Save size={13} />}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}
