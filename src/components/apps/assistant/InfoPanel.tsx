"use client";

import { useCallback, useEffect, useState } from "react";
import { Wrench, Sparkles, Plug, PlugZap, Loader2 } from "lucide-react";
import { useCoAgent } from "@copilotkit/react-core";
import { ASSISTANT_TOOLS } from "@/lib/agent/tool-manifest";
import type { Skill } from "@/lib/agent/skills/store";
import type { McpServerConfig } from "@/lib/mcp/types";

type Tab = "tools" | "skills" | "mcp" | "state";

// An unset/empty allowlist means "all" (011-per-agent-capabilities).
function allows(allow: string[] | undefined, id: string): boolean {
  return !allow || allow.length === 0 || allow.includes(id);
}

export function InfoPanel({ agentId }: { agentId?: string }) {
  const [tab, setTab] = useState<Tab>("tools");
  const [caps, setCaps] = useState<{ skills: string[]; mcp: string[] } | null>(null);

  // Reflect THIS conversation's agent's scoped skills/MCP (no global active agent).
  // (Tools span two id namespaces — see TODO.md — so the Tools tab still lists all.)
  useEffect(() => {
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((d) => {
        const agent = (d.agents ?? []).find((a: { id: string }) => a.id === agentId);
        setCaps({ skills: agent?.skills ?? [], mcp: agent?.mcp ?? [] });
      })
      .catch(() => setCaps({ skills: [], mcp: [] }));
  }, [agentId]);

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-l border-white/10 bg-white/[0.02]">
      <div className="flex shrink-0 border-b border-white/10 text-xs">
        {(["tools", "skills", "mcp", "state"] as Tab[]).map((t) => (
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
        {tab === "skills" && <SkillsTab allowed={caps?.skills} />}
        {tab === "mcp" && <McpTab allowed={caps?.mcp} />}
        {tab === "state" && <SessionStateTab />}
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

// CopilotKit "shared state" (AG-UI): a state object synchronized between the
// assistant and this app. The assistant reads it (sent up with each run) and
// updates it via the AGUISendStateSnapshot/AGUISendStateDelta tools; those updates
// stream back here and re-render live. The client agent id is "default" (we don't
// pin a `<CopilotKit agent=…>`), which is the agent this panel reflects.
const STATE_TRANSPORT_KEYS = ["messages", "tools", "copilotkit"];

function SessionStateTab() {
  const { state } = useCoAgent<Record<string, unknown>>({ name: "default", initialState: {} });
  const visible = Object.fromEntries(
    Object.entries(state ?? {}).filter(([k]) => !STATE_TRANSPORT_KEYS.includes(k)),
  );
  const isEmpty = Object.keys(visible).length === 0;
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-white/45">
        Live session state shared with the assistant. It reads and updates this as it works.
      </p>
      {isEmpty ? (
        <p className="text-white/40">No session state yet.</p>
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 p-2 text-[10px] leading-relaxed text-white/80">
          {JSON.stringify(visible, null, 2)}
        </pre>
      )}
    </div>
  );
}

function SkillsTab({ allowed }: { allowed?: string[] }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  useEffect(() => {
    fetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills ?? [])).catch(() => setSkills([]));
  }, []);
  if (!skills) return <p className="text-white/40">Loading…</p>;
  const shown = skills.filter((s) => allows(allowed, s.id));
  if (shown.length === 0) return <p className="text-white/40">No skills available to this agent.</p>;
  return (
    <div className="space-y-2">
      {shown.map((s) => (
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

function McpTab({ allowed }: { allowed?: string[] }) {
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [status, setStatus] = useState<Record<string, "checking" | "connected" | "disconnected">>({});

  const probe = useCallback(async (list: McpServerConfig[]) => {
    for (const s of list) {
      setStatus((st) => ({ ...st, [s.name]: "checking" }));
      try {
        const res = await fetch(`/api/mcp?probe=${encodeURIComponent(s.name)}`).then((r) => r.json());
        setStatus((st) => ({ ...st, [s.name]: res.result?.ok ? "connected" : "disconnected" }));
      } catch {
        setStatus((st) => ({ ...st, [s.name]: "disconnected" }));
      }
    }
  }, []);

  useEffect(() => {
    fetch("/api/mcp")
      .then((r) => r.json())
      .then((d) => {
        const all: McpServerConfig[] = d.servers ?? [];
        const shown = all.filter((s) => allows(allowed, s.name) || allows(allowed, s.endpoint ?? ""));
        setServers(shown);
        probe(shown);
      })
      .catch(() => setServers([]));
  }, [probe, allowed]);

  if (!servers) return <p className="text-white/40">Loading…</p>;
  if (servers.length === 0) return <p className="text-white/40">No MCP servers available to this agent.</p>;
  return (
    <div className="space-y-1.5">
      {servers.map((s) => {
        const st = status[s.name] ?? "checking";
        const detail = s.endpoint || [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
        return (
          <div key={s.name} className="rounded border border-white/10 bg-white/[0.03] p-2">
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
            <p className="mt-0.5 truncate text-[10px] text-white/40">{detail}</p>
          </div>
        );
      })}
    </div>
  );
}
