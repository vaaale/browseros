"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, MessageSquare } from "lucide-react";
import {
  useConversations,
  useAllConversations,
  newConversation,
  selectConversation,
  deleteConversation,
  DEFAULT_GROUP,
  type Conversation,
} from "@/lib/agent/conversations";

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

// Effective agent for a conversation. Pre-existing chats have no agentId and
// fall back to the group name (embeds were historically pinned to the group's
// agent) or the globally active agent (Assistant-app default).
function effectiveAgent(c: Conversation, globalActive: string): string {
  if (c.agentId) return c.agentId;
  if (c.group && c.group !== DEFAULT_GROUP) return c.group;
  return globalActive;
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

// `group` set → only that group's conversations (embedded chats).
// `group` unset → all conversations grouped by AGENT (the Assistant app); each
// section is an agent and the "+ New" button creates a conversation pinned to
// that agent. Picking a conversation calls onPickGroup so the host can follow
// its underlying conversation-group (which determines which thread is active).
export function ConversationPanel({ group, onPickGroup }: { group?: string; onPickGroup?: (group: string) => void }) {
  const single = useConversations(group ?? DEFAULT_GROUP);
  const all = useAllConversations();
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [globalActive, setGlobalActive] = useState("");

  // The agent list is what we group BY in the all-groups view — labels and
  // section ordering come from it. Refetched whenever the conversation set
  // changes so a new conversation's agent (just added in Settings, for example)
  // resolves to its display name instead of falling back to its raw id.
  useEffect(() => {
    if (group) return;
    let alive = true;
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setAgents(d.agents ?? []);
        setGlobalActive(d.active ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [group, all.conversations.length]);

  if (group) {
    return (
      <div className="flex h-full w-48 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
        <div className="flex items-center justify-between px-2 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/40">Chats</span>
          <button
            onClick={() => void newConversation(group, group !== DEFAULT_GROUP ? group : undefined)}
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

  // Bucket conversations by their effective agent. Section order: known agents
  // in the order /api/assistant/agent returned them, then any leftover ids
  // (agents that no longer exist) alphabetically — so deleting an agent doesn't
  // hide its conversations.
  const buckets = new Map<string, Conversation[]>();
  for (const c of all.conversations) {
    const key = effectiveAgent(c, globalActive) || "unassigned";
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
        {ordered.map((agentId) => (
          <div key={agentId}>
            <div className="flex items-center justify-between px-1 py-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-white/35">{nameFor(agentId)}</span>
              <button
                onClick={() => {
                  // New conversations from the Assistant app live in the
                  // default partition; the agent pin is what classifies them.
                  void newConversation(DEFAULT_GROUP, agentId).then(() => onPickGroup?.(DEFAULT_GROUP));
                }}
                title={`New ${nameFor(agentId)} conversation`}
                className="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="space-y-0.5">
              {(buckets.get(agentId) ?? []).map((c) => (
                <ConvRow
                  key={c.id}
                  c={c}
                  active={all.activeByGroup[c.group] === c.id}
                  onPick={() => onPickGroup?.(c.group)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
