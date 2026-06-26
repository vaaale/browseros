"use client";

import { useCallback, useEffect, useState } from "react";
import { Wrench, Sparkles, Plug, PlugZap, Loader2 } from "lucide-react";
import { ASSISTANT_TOOLS } from "@/lib/agent/tool-manifest";
import type { Skill } from "@/lib/agent/skills/store";
import type { McpServerConfig } from "@/lib/mcp/types";

type Tab = "tools" | "skills" | "mcp";

export function InfoPanel() {
  const [tab, setTab] = useState<Tab>("tools");
  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-l border-white/10 bg-white/[0.02]">
      <div className="flex shrink-0 border-b border-white/10 text-xs">
        {(["tools", "skills", "mcp"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 capitalize ${tab === t ? "border-b-2 border-white/50 text-white" : "text-white/50 hover:text-white/80"}`}
          >
            {t === "mcp" ? "MCP" : t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {tab === "tools" && <ToolsTab />}
        {tab === "skills" && <SkillsTab />}
        {tab === "mcp" && <McpTab />}
      </div>
    </div>
  );
}

function ToolsTab() {
  const groups = Array.from(new Set(ASSISTANT_TOOLS.map((t) => t.group)));
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">{g}</div>
          {ASSISTANT_TOOLS.filter((t) => t.group === g).map((t) => (
            <div key={t.name} className="flex items-start gap-1.5 py-0.5">
              <Wrench size={11} className="mt-0.5 shrink-0 text-white/40" />
              <div>
                <span className="font-mono text-white/85">{t.name}</span>
                <span className="block text-[10px] text-white/45">{t.description}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SkillsTab() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  useEffect(() => {
    fetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills ?? [])).catch(() => setSkills([]));
  }, []);
  if (!skills) return <p className="text-white/40">Loading…</p>;
  if (skills.length === 0) return <p className="text-white/40">No skills yet.</p>;
  return (
    <div className="space-y-2">
      {skills.map((s) => (
        <div key={s.id} className="rounded border border-white/10 bg-white/[0.03] p-2">
          <div className="flex items-center gap-1.5">
            <Sparkles size={11} className="text-amber-300/80" />
            <span className="font-medium text-white/85">{s.name}</span>
          </div>
          <p className="mt-0.5 text-[10px] text-white/45">{s.description}</p>
        </div>
      ))}
    </div>
  );
}

function McpTab() {
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [status, setStatus] = useState<Record<string, "checking" | "connected" | "disconnected">>({});

  const probe = useCallback(async (list: McpServerConfig[]) => {
    for (const s of list) {
      setStatus((st) => ({ ...st, [s.endpoint]: "checking" }));
      try {
        const res = await fetch(`/api/mcp?probe=${encodeURIComponent(s.endpoint)}`).then((r) => r.json());
        setStatus((st) => ({ ...st, [s.endpoint]: res.result?.ok ? "connected" : "disconnected" }));
      } catch {
        setStatus((st) => ({ ...st, [s.endpoint]: "disconnected" }));
      }
    }
  }, []);

  useEffect(() => {
    fetch("/api/mcp")
      .then((r) => r.json())
      .then((d) => {
        setServers(d.servers ?? []);
        probe(d.servers ?? []);
      })
      .catch(() => setServers([]));
  }, [probe]);

  if (!servers) return <p className="text-white/40">Loading…</p>;
  if (servers.length === 0) return <p className="text-white/40">No MCP servers configured.</p>;
  return (
    <div className="space-y-1.5">
      {servers.map((s) => {
        const st = status[s.endpoint] ?? "checking";
        return (
          <div key={s.endpoint} className="rounded border border-white/10 bg-white/[0.03] p-2">
            <div className="flex items-center gap-1.5">
              {st === "connected" ? (
                <PlugZap size={12} className="text-emerald-300" />
              ) : st === "checking" ? (
                <Loader2 size={12} className="animate-spin text-white/40" />
              ) : (
                <Plug size={12} className="text-white/30" />
              )}
              <span className="truncate font-medium text-white/85">{s.name}</span>
              <span className={`ml-auto text-[10px] ${st === "connected" ? "text-emerald-300" : "text-white/40"}`}>{st}</span>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-white/40">{s.endpoint}</p>
          </div>
        );
      })}
    </div>
  );
}
