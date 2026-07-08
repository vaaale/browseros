"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, MessageSquare } from "lucide-react";
import {
  useConversations,
  useAllConversations,
  newConversation,
  selectConversation,
  deleteConversation,
  type Conversation,
} from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

interface AgentMeta {
  id: string;
  name: string;
}

function humanize(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function ConvRow({ c, active, onPick }: { c: Conversation; active: boolean; onPick?: () => void }) {
  return (
    <div
      className={`group flex items-center gap-1.5 rounded px-2 py-1.5 text-xs ${
        active ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
      }`}
    >
      <MessageSquare size={12} className="shrink-0 text-white/40" />
      <button
        onClick={() => {
          selectConversation(c.id);
          onPick?.();
        }}
        className="flex-1 truncate text-left"
      >
        {c.title}
      </button>
      <button
        onClick={() => void deleteConversation(c.id)}
        title="Delete"
        className="rounded p-0.5 text-white/30 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// `agentId` set → only that agent's conversations (embedded chats).
// `agentId` unset → all conversations grouped by agent (the Assistant app).
// `currentAgentId` is the agent currently selected in the host (all-agents view
// only): conversations outside this agent are not highlighted even if they are
// each active within their own agent's list.
export function ConversationPanel({
  agentId,
  currentAgentId,
  onPickAgent,
}: {
  agentId?: string;
  currentAgentId?: string;
  onPickAgent?: (agentId: string) => void;
}) {
  const single = useConversations(agentId ?? DEFAULT_AGENT_ID);
  const all = useAllConversations();
  const [agents, setAgents] = useState<AgentMeta[]>([]);

  useEffect(() => {
    if (agentId) return;
    let alive = true;
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setAgents(d.agents ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId, all.conversations.length]);

  if (agentId) {
    return (
      <div className="flex h-full w-48 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
        <div className="flex items-center justify-between px-2 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/40">Chats</span>
          <button
            onClick={() => void newConversation(agentId)}
            title="New conversation"
            className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1.5 pb-2">
          {single.conversations.map((c) => (
            <ConvRow key={c.id} c={c} active={single.activeId === c.id} />
          ))}
        </div>
      </div>
    );
  }

  const nameFor = (id: string): string => agents.find((a) => a.id === id)?.name ?? humanize(id || "Unassigned");

  // Bucket conversations by agentId. Section order: known agents in the order
  // the API returned them, then any unknown ids alphabetically.
  const buckets = new Map<string, Conversation[]>();
  for (const c of all.conversations) {
    const key = c.agentId || DEFAULT_AGENT_ID;
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }
  const ordered: string[] = [];
  for (const a of agents) if (buckets.has(a.id)) ordered.push(a.id);
  for (const k of Array.from(buckets.keys()).sort()) if (!ordered.includes(k)) ordered.push(k);

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
      <div className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-white/40">Chats</div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-1.5 pb-2">
        {ordered.map((aid) => (
          <div key={aid}>
            <div className="flex items-center justify-between px-1 py-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-white/35">{nameFor(aid)}</span>
              <button
                onClick={() => {
                  void newConversation(aid).then(() => onPickAgent?.(aid));
                }}
                title={`New ${nameFor(aid)} conversation`}
                className="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="space-y-0.5">
              {(buckets.get(aid) ?? []).map((c) => (
                <ConvRow
                  key={c.id}
                  c={c}
                  active={c.agentId === (currentAgentId ?? DEFAULT_AGENT_ID) && all.activeByAgent[c.agentId] === c.id}
                  onPick={() => onPickAgent?.(c.agentId)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
