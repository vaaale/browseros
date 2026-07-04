"use client";

import { useCallback, useEffect, useState } from "react";
import { GitBranch, MessageSquare, Trash2, UserCircle } from "lucide-react";
import {
  DEFAULT_GROUP,
  deleteConversation,
  newConversation,
  selectConversation,
  setConversationAgent,
  setConversationActiveFeatureBranch,
  useActiveConversation,
  useConversations,
} from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

interface AgentMeta {
  id: string;
  name: string;
}

// The selector reflects (and edits) the ACTIVE conversation's agent — the only
// source of truth. Picking a new agent reassigns THIS conversation in-place
// (moving it under that agent's section). There is no global "active agent".
export function AgentSelector({ group = DEFAULT_GROUP }: { group?: string }) {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const conv = useActiveConversation(group);

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/agent").then((r) => r.json());
    setAgents(res.agents ?? []);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  // The dropdown shows the active conversation's agent; a conversation that
  // predates per-conversation agents falls back to the built-in default id only
  // for display (its runtime agent is resolved from the tagged id going forward).
  const shown = conv?.agentId ?? DEFAULT_AGENT_ID;

  const onChange = async (id: string) => {
    if (conv) await setConversationAgent(conv.id, id);
  };

  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60" title="Agent assigned to this conversation">
      <UserCircle size={14} className="text-white/50" />
      <select
        value={shown}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-white/85 outline-none focus:border-white/30"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </label>
  );
}

interface BranchState {
  featureBranches: string[];
}

export function FeatureBranchSelector({ group = DEFAULT_GROUP }: { group?: string }) {
  const conv = useActiveConversation(group);
  const [branches, setBranches] = useState<BranchState>({ featureBranches: [] });

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/feature-branches")
      .then((r) => r.json())
      .catch(() => null);
    setBranches({
      featureBranches: Array.isArray(res?.featureBranches) ? res.featureBranches : [],
    });
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  if (!conv) return null;

  const value = conv.activeFeatureBranch ?? "";
  const shownBranches = value && !branches.featureBranches.includes(value)
    ? [value, ...branches.featureBranches]
    : branches.featureBranches;
  const onChange = async (next: string) => {
    if (next === "__new__") {
      const name = window.prompt("Feature branch name (kebab-case, up to 4 segments)", "");
      if (!name) return;
      const created = await fetch("/api/assistant/feature-branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((r) => r.json());
      if (!created.ok || typeof created.branch !== "string") {
        window.alert(created.error ?? "Could not create feature branch");
        return;
      }
      await setConversationActiveFeatureBranch(conv.id, created.branch);
      setBranches({
        featureBranches: Array.isArray(created.featureBranches) ? created.featureBranches : [created.branch],
      });
      return;
    }
    await setConversationActiveFeatureBranch(conv.id, next);
  };

  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60" title="Feature branch targeted by Developer harness work in this conversation">
      <GitBranch size={14} className="text-white/50" />
      <span>Active feature branch</span>
      <select
        value={value}
        onChange={(e) => void onChange(e.target.value)}
        className="max-w-[220px] rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-white/85 outline-none focus:border-white/30"
      >
        <option value="">Select branch...</option>
        {shownBranches.map((branch) => (
          <option key={branch} value={branch}>{branch}</option>
        ))}
        <option value="__new__">New feature branch...</option>
      </select>
    </label>
  );
}

// Compact conversation picker for embedded chats that don't have room for the
// full ConversationPanel (e.g. Build Studio). Lists conversations in `group`,
// with an inline "New conversation..." option and a trash button that deletes
// the active thread. `agentId` pins new conversations to a specific agent (an
// embed pins to its group's agent).
export function ConversationSelector({
  group = DEFAULT_GROUP,
  agentId,
}: {
  group?: string;
  agentId?: string;
}) {
  const { conversations, activeId } = useConversations(group);

  const onChange = async (next: string) => {
    if (next === "__new__") {
      await newConversation(group, agentId ?? (group !== DEFAULT_GROUP ? group : undefined));
      return;
    }
    selectConversation(next);
  };

  const onDelete = () => {
    if (!activeId) return;
    if (!window.confirm("Delete this conversation?")) return;
    void deleteConversation(activeId);
  };

  return (
    <span className="flex items-center gap-1 text-xs text-white/60">
      <label className="flex items-center gap-1.5" title="Active conversation">
        <MessageSquare size={14} className="text-white/50" />
        <select
          value={activeId}
          onChange={(e) => void onChange(e.target.value)}
          className="max-w-[240px] rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-white/85 outline-none focus:border-white/30"
        >
          {conversations.length === 0 && <option value="">No conversations</option>}
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
          <option value="__new__">New conversation...</option>
        </select>
      </label>
      <button
        onClick={onDelete}
        disabled={!activeId}
        title="Delete this conversation"
        className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/40"
      >
        <Trash2 size={12} />
      </button>
    </span>
  );
}
