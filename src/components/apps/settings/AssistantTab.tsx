"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Plus } from "lucide-react";

interface AgentMeta {
  id: string;
  name: string;
  description: string;
  type: string;
}

export function AssistantTab() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [active, setActive] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/agent").then((r) => r.json());
    setAgents(res.agents ?? []);
    setActive(res.active ?? "");
    setBody(res.activeBody ?? "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const switchTo = async (id: string) => {
    await fetch("/api/assistant/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: id }),
    });
    setStatus(`Active agent: ${id}.`);
    load();
  };

  const saveBody = async () => {
    await fetch("/api/assistant/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setStatus("Saved agent instructions.");
  };

  const createAgent = async () => {
    if (!newName.trim()) return;
    await fetch("/api/assistant/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), body: "You are a helpful BrowserOS assistant." }),
    });
    setNewName("");
    load();
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-white/50">
        The main assistant adopts one agent&apos;s instructions as its personality. Pick the active agent, edit its
        instructions, or create a new one. (These are the same agents the assistant can delegate to.)
      </p>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Agents</h4>
        <div className="space-y-1">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => switchTo(a.id)}
              className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-left text-xs ${
                active === a.id ? "border-white/30 bg-white/10" : "border-white/10 hover:bg-white/5"
              }`}
            >
              {active === a.id ? <Check size={13} className="text-emerald-300" /> : <span className="w-[13px]" />}
              <span className="font-medium">{a.name}</span>
              <span className="rounded bg-white/10 px-1 text-[10px] uppercase text-white/40">{a.type}</span>
              <span className="truncate text-white/40">{a.description}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New agent name"
            className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
          />
          <button onClick={createAgent} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1.5 text-xs hover:bg-white/20">
            <Plus size={13} /> New
          </button>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Active agent instructions</h4>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          spellCheck={false}
          className="w-full resize-none rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/30"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={saveBody} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Save</button>
          {status && <span className="text-xs text-white/60">{status}</span>}
        </div>
      </div>
    </div>
  );
}
