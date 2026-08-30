"use client";

import { useCallback, useEffect, useState } from "react";
import { GitBranch, MessageSquare, Trash2, UserCircle } from "lucide-react";
import {
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

export function AgentSelector({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const conv = useActiveConversation(agentId);

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/agent").then((r) => r.json());
    setAgents(res.agents ?? []);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

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

export function FeatureBranchSelector({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  const conv = useActiveConversation(agentId);
  const [branches, setBranches] = useState<{ featureBranches: string[] }>({ featureBranches: [] });

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

export function ConversationSelector({
  agentId = DEFAULT_AGENT_ID,
}: {
  agentId?: string;
}) {
  const { conversations, activeId } = useConversations(agentId);
  // Arm-then-confirm instead of window.confirm: a native blocking dialog
  // here is a known trigger for React's "flushSync was called from inside a
  // lifecycle method" warning (it re-enters the event loop synchronously
  // mid-handler, ahead of a useSyncExternalStore-backed update), the same
  // reason the rest of BOS avoids window.confirm/alert/prompt for anything
  // that follows with a state change.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const onChange = async (next: string) => {
    setConfirming(false);
    if (next === "__new__") {
      await newConversation(agentId);
      return;
    }
    selectConversation(next);
  };

  const onDelete = () => {
    if (!activeId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
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
        onBlur={() => setConfirming(false)}
        disabled={!activeId}
        title={confirming ? "Click again to confirm delete" : "Delete this conversation"}
        className={`rounded p-1 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/40 ${
          confirming ? "bg-red-500/20 text-red-300 hover:bg-red-500/30" : "text-white/40 hover:bg-white/10 hover:text-white"
        }`}
      >
        <Trash2 size={12} />
      </button>
    </span>
  );
}
