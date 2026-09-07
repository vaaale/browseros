"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Wrench, Sparkles, Plug, PlugZap, Loader2 } from "lucide-react";
import { assistantToolsManifest } from "@/lib/agent/tool-manifest";
import { classifyToolState, DISCOVERY_TOOL_IDS, type ToolState } from "@/lib/agent/tool-state";
import { useChatSelector } from "@/lib/assistant/client/chat-store";
// The CLIENT-SAFE deriveRevealedIds (framework-free, zero imports, reads the
// persisted ChatMessage[] shape) — the exact function agent-loop.ts calls, so
// the panel's colours cannot diverge from the run's gate. NOT the same-named
// export in src/lib/agent/tool-gate.ts, which is `import "server-only"` and
// reads the in-memory model-prompt shape instead (042 design risk 1).
import { deriveRevealedIds } from "@/lib/assistant/messages";
import type { Skill } from "@/lib/agent/skills/store";
import type { McpServerConfig } from "@/lib/mcp/types";

// v2 InfoPanel — the tools / skills / MCP tabs, CopilotKit-free (the old
// session-state tab used useCoAgent / AG-UI shared state; v2 session state via
// state_get/set is a later increment — §2.8 of the plan — so it is omitted).

type Tab = "tools" | "skills" | "mcp";

// Lenient allowlist check for the Skills / MCP tabs: an empty or unknown list
// means "allow all", which avoids a disabled-flash while the agent fetch is in
// flight. The Tools tab deliberately does NOT use this — the run's gate is
// strict (an empty allowlist grants nothing), so tool colouring goes through
// classifyToolState instead (042).
function allows(allow: string[] | undefined, id: string): boolean {
  return !allow || allow.length === 0 || allow.includes(id);
}

interface AgentCaps {
  skills: string[];
  mcp: string[];
  tools: string[];
  deferredTools: string[];
}

const NO_CAPS: AgentCaps = { skills: [], mcp: [], tools: [], deferredTools: [] };

export function InfoPanelV2({ agentId, conversationId }: { agentId?: string; conversationId?: string }) {
  const [tab, setTab] = useState<Tab>("tools");
  const [caps, setCaps] = useState<AgentCaps | null>(null);

  useEffect(() => {
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((d) => {
        const agent = (d.agents ?? []).find((a: { id: string }) => a.id === agentId);
        setCaps({
          skills: agent?.skills ?? [],
          mcp: agent?.mcp ?? [],
          tools: agent?.tools ?? [],
          deferredTools: agent?.deferredTools ?? [],
        });
      })
      .catch(() => setCaps(NO_CAPS));
  }, [agentId]);

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
        {tab === "tools" && (
          <ToolsTab
            tools={caps?.tools ?? null}
            deferredTools={caps?.deferredTools ?? null}
            conversationId={conversationId ?? ""}
          />
        )}
        {tab === "skills" && <SkillsTab allowed={caps?.skills} />}
        {tab === "mcp" && <McpTab allowed={caps?.mcp} />}
      </div>
    </div>
  );
}

// 042-tool-color-coding: the wrench icon carries the state. `neutral` keeps the
// grey every row had before this feature, so "no state" is the absence of a
// colour rather than a fifth one.
const STATE_COLOR: Record<ToolState, string> = {
  granted: "text-emerald-400",
  deferredHidden: "text-amber-400",
  deferredRevealed: "text-sky-400",
  neutral: "text-white/40",
};

function LegendRow({ dot, label }: { dot: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="text-[10px] text-white/55">{label}</span>
    </div>
  );
}

/** `tools` / `deferredTools` are the SELECTED AGENT's lists, or null while the
 *  /api/assistant/agent fetch is unresolved — null means "unknown", which
 *  renders every row neutral (no green flash on tools the agent may not have).
 *  An empty list is the strict "grants nothing" the run's gate applies. */
function ToolsTab({
  tools: allowedTools,
  deferredTools,
  conversationId,
}: {
  tools: string[] | null;
  deferredTools: string[] | null;
  conversationId: string;
}) {
  // Scoped to this tab on purpose: ToolsTab is mounted only while the Tools tab
  // is active, so the transcript subscription (and its re-renders) stops on the
  // Skills / MCP tabs and never reaches the memoized AssistantChatV2. The
  // selector returns a stable reference on text_delta / tool_progress, so this
  // re-renders on a real transcript append, not per streamed token.
  const messages = useChatSelector(conversationId, (s) => s.messages);
  const revealed = useMemo(() => deriveRevealedIds(messages), [messages]);
  const allow = useMemo(() => new Set(allowedTools ?? []), [allowedTools]);
  const deferred = useMemo(() => new Set(deferredTools ?? []), [deferredTools]);

  // Rebuilt per render, not read from a module constant: a marketplace item's
  // service tools enter and leave the registry as its service starts and stops
  // (041-tool-groups).
  const tools = assistantToolsManifest();
  const groups = Array.from(new Set(tools.map((t) => t.group)));
  return (
    <>
      <div className="mb-3 space-y-1 border-b border-white/10 pb-2">
        <LegendRow dot="bg-emerald-400" label="Granted" />
        <LegendRow dot="bg-amber-400" label="Deferred · hidden" />
        <LegendRow dot="bg-sky-400" label="Deferred · revealed" />
        <LegendRow dot="bg-white/40" label="Not granted" />
      </div>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              {tools.find((t) => t.group === g)?.groupName ?? `${g} (unknown group)`}
            </div>
            {tools.filter((t) => t.group === g).map((t) => {
              const state = classifyToolState(t.name, {
                allow,
                deferred,
                revealed,
                isDiscovery: DISCOVERY_TOOL_IDS.has(t.name),
              });
              return (
                <div key={t.name} className="flex items-start gap-1.5 py-0.5">
                  <Wrench size={11} className={`mt-0.5 shrink-0 ${STATE_COLOR[state]}`} />
                  <div>
                    <span className="font-mono text-white/85">{t.name}</span>
                    <span className="block text-[10px] text-white/45">{t.description}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
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
