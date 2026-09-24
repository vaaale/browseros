"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";

// Settings → Build Studio: which sub-agent powers the Build Studio app's chat
// (the `build-studio` config namespace, read by the app on mount). This file
// restores a tab that was referenced by src/apps/settings/index.tsx but missing
// from the repo (the import was committed without the component).
//
// 035-spec-promote-conflict-escalation (FR-025) adds a SECOND field:
// `conflictAgent`, the agent the reconciliation pipeline escalates git
// conflicts to. Unlike `agent` (read by the app on mount), this one is read on
// EVERY escalation, so a change takes effect immediately with no reload.

interface AgentOption {
  id: string;
  name: string;
  description?: string;
  tools?: string[];
}

/** The six ids an agent must have in its allowlist to actually resolve a
 *  conflict — `gate.ts` only offers a run the tools its agent lists, so an
 *  agent without them fails at the first tool call (FR-025's stated,
 *  intended behaviour). Warn here instead of letting the user find out at
 *  escalation time. */
const CONFLICT_TOOL_IDS = [
  "conflict_read",
  "conflict_write",
  "conflict_decision",
  "conflict_status",
  "conflict_complete",
  "conflict_abandon",
];

function hasConflictTools(a: AgentOption): boolean {
  return CONFLICT_TOOL_IDS.every((id) => a.tools?.includes(id));
}

export function BuildStudioTab() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [conflictAgent, setConflictAgent] = useState<string>("devops");
  // 045 FR-008/FR-008a — the LAST link in the binding chain
  // (project.json -> spec-store.json -> here -> spec-kit), and PER USER:
  // `data/` is a per-user volume under Bastion.
  const [defaultMethod, setDefaultMethod] = useState<string>("spec-kit");
  const [methods, setMethods] = useState<{ id: string; label: string; builtin?: boolean }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/subagents").then((r) => r.json()),
      fetch("/api/methods").then((r) => r.json()).catch(() => ({ methods: [] })),
    ])
      .then(([cfg, subs, meth]) => {
        const s = (cfg.schemas ?? []).find((x: { namespace: string }) => x.namespace === "build-studio");
        const values = s?.values as { agent?: string; conflictAgent?: string; defaultMethod?: string } | undefined;
        setAgent(String(values?.agent || "build-studio"));
        setConflictAgent(String(values?.conflictAgent || "devops"));
        setDefaultMethod(String(values?.defaultMethod || "spec-kit"));
        setMethods((meth.methods ?? []) as { id: string; label: string; builtin?: boolean }[]);
        setAgents(((subs.subAgents ?? []) as AgentOption[]).map((a) => ({ id: a.id, name: a.name, description: a.description, tools: a.tools })));
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
        body: JSON.stringify({ namespace: "build-studio", values: { agent, conflictAgent, defaultMethod } }),
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const selected = agents.find((a) => a.id === agent);
  const selectedConflict = agents.find((a) => a.id === conflictAgent);

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

      <hr className="border-white/10" />

      <p className="text-white/50">
        The agent the git reconciliation pipeline escalates a <b>merge conflict</b> to, in whichever repo the
        conflict was detected — BOS source, a spec store, user-apps, or a VFS mount. It resolves what it can on its
        own and asks you in the Build Studio conflict pane when it genuinely can&rsquo;t decide. Read on every
        escalation, so a change here takes effect immediately.
      </p>

      <label className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-white/60">Conflict agent</span>
        <select
          data-testid="build-studio-conflict-agent"
          value={conflictAgent}
          onChange={(e) => {
            setConflictAgent(e.target.value);
            setSaved(false);
          }}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
        >
          {!agents.some((a) => a.id === conflictAgent) && <option value={conflictAgent}>{conflictAgent}</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      <h3 className="mt-4 font-medium text-white/80">Default spec method</h3>
      <p className="text-white/50">
        The spec framework a store uses when it sets none of its own. A store&rsquo;s own binding
        (<code>spec-store.json</code>) and a Project&rsquo;s override both win over this. Applies to{" "}
        <strong>your account only</strong> &mdash; each user has their own <code>data/</code> volume, so changing
        this never moves anyone else&rsquo;s stores.
      </p>

      <label className="grid grid-cols-[120px_1fr] items-center gap-2">
        <span className="text-white/60">Default method</span>
        <select
          data-testid="build-studio-default-method"
          value={defaultMethod}
          onChange={(e) => {
            setDefaultMethod(e.target.value);
            setSaved(false);
          }}
          className="rounded border border-white/10 bg-black/30 px-2 py-1.5 outline-none focus:border-white/30"
        >
          {/* A method named here but not installed must stay selectable, or
              saving would silently change the binding to whatever happens to be
              first in the list. */}
          {!methods.some((m) => m.id === defaultMethod) && (
            <option value={defaultMethod}>{defaultMethod} (not installed)</option>
          )}
          {methods.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.builtin ? " (built in)" : ""}
            </option>
          ))}
        </select>
      </label>

      {methods.length <= 1 && (
        <p className="pl-[128px] text-white/40">
          Only the built-in method is installed, so there is nothing else to choose yet. Install a method pack
          from the Marketplace to get more options.
        </p>
      )}

      {selectedConflict && (
        <p className="pl-[128px] text-white/40">
          {selectedConflict.description}
          {!hasConflictTools(selectedConflict) && (
            <span className="mt-1 block text-amber-300/80">
              Heads up: this agent has to have the <code>conflict_*</code> tools in its allowlist (Settings →
              Agents → Tools) or the escalation will fail immediately with a clear error instead of resolving
              anything.
            </span>
          )}
        </p>
      )}

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
