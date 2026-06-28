"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Plus } from "lucide-react";

interface AgentMeta {
  id: string;
  name: string;
  description: string;
  type: string;
  tools: string[];
  skills: string[];
  mcp: string[];
}

interface Catalog {
  tools: string[];
  skills: { id: string; name: string }[];
  mcp: { name: string; endpoint: string }[];
}

interface CatalogItem {
  id: string;
  label: string;
  sub?: string;
}

const EMPTY_CATALOG: Catalog = { tools: [], skills: [], mcp: [] };

// A checked set initialized from an allowlist: an EMPTY allowlist means "all", so
// it initializes with every item checked. On save, a fully-checked set is written
// back as [] (the canonical "all").
function initChecked(allow: string[], allIds: string[]): Set<string> {
  return new Set(allow.length ? allow : allIds);
}

function CapabilityGroup({
  title,
  items,
  checked,
  onToggle,
}: {
  title: string;
  items: CatalogItem[];
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) return null;
  const all = checked.size === items.length;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h5 className="text-[10px] font-semibold uppercase tracking-wide text-white/50">{title}</h5>
        <span className="text-[10px] text-white/35">{all ? "all allowed" : `${checked.size} of ${items.length}`}</span>
      </div>
      <div className="max-h-40 space-y-0.5 overflow-auto rounded border border-white/10 bg-black/20 p-1.5">
        {items.map((it) => (
          <label key={it.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-white/5">
            <input type="checkbox" checked={checked.has(it.id)} onChange={() => onToggle(it.id)} className="accent-[#5b8cff]" />
            <span className="truncate font-mono text-white/80">{it.label}</span>
            {it.sub && <span className="truncate text-[10px] text-white/30">{it.sub}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

export function AssistantTab() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [active, setActive] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [mcp, setMcp] = useState<Set<string>>(new Set());

  const toolItems = useMemo<CatalogItem[]>(() => catalog.tools.map((t) => ({ id: t, label: t })), [catalog]);
  const skillItems = useMemo<CatalogItem[]>(() => catalog.skills.map((s) => ({ id: s.id, label: s.name })), [catalog]);
  const mcpItems = useMemo<CatalogItem[]>(() => catalog.mcp.map((m) => ({ id: m.name, label: m.name, sub: m.endpoint })), [catalog]);

  const loadCaps = useCallback((agent: AgentMeta | undefined, cat: Catalog) => {
    setTools(initChecked(agent?.tools ?? [], cat.tools));
    setSkills(initChecked(agent?.skills ?? [], cat.skills.map((s) => s.id)));
    setMcp(initChecked(agent?.mcp ?? [], cat.mcp.map((m) => m.name)));
  }, []);

  const load = useCallback(() => {
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((res) => {
        const list: AgentMeta[] = res.agents ?? [];
        const cat: Catalog = res.catalog ?? EMPTY_CATALOG;
        setAgents(list);
        setActive(res.active ?? "");
        setBody(res.activeBody ?? "");
        setCatalog(cat);
        loadCaps(list.find((a) => a.id === res.active), cat);
      })
      .catch(() => {});
  }, [loadCaps]);

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

  // A fully-checked set is saved as [] (canonical "all", unrestricted).
  const toAllow = (checked: Set<string>, total: number): string[] => (checked.size === total ? [] : [...checked]);

  const saveCaps = async () => {
    await fetch("/api/assistant/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: active,
        tools: toAllow(tools, toolItems.length),
        skills: toAllow(skills, skillItems.length),
        mcp: toAllow(mcp, mcpItems.length),
      }),
    });
    setStatus("Saved agent capabilities.");
    load();
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const activeAgent = agents.find((a) => a.id === active);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-white/50">
        The main assistant adopts one agent&apos;s instructions as its personality. Pick the active agent, edit its
        instructions and capabilities, or create a new one. (These are the same agents the assistant can delegate to.)
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
          rows={10}
          spellCheck={false}
          className="w-full resize-none rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/30"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={saveBody} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Save instructions</button>
        </div>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/50">
          Capabilities {activeAgent ? `· ${activeAgent.name}` : ""}
        </h4>
        <p className="mb-2 text-[10px] text-white/40">
          Check the tools, skills, and MCP servers this agent may use. Leaving a group fully checked means
          &ldquo;all allowed&rdquo;. (Tools here are sub-agent tools; main-chat action scoping is tracked separately.)
        </p>
        <div className="space-y-3">
          <CapabilityGroup title="Skills" items={skillItems} checked={skills} onToggle={(id) => toggle(skills, setSkills, id)} />
          <CapabilityGroup title="MCP servers" items={mcpItems} checked={mcp} onToggle={(id) => toggle(mcp, setMcp, id)} />
          <CapabilityGroup title="Tools" items={toolItems} checked={tools} onToggle={(id) => toggle(tools, setTools, id)} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button onClick={saveCaps} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Save capabilities</button>
          {status && <span className="text-xs text-white/60">{status}</span>}
        </div>
      </div>
    </div>
  );
}
