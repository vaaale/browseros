"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, GitBranch, MessageSquare, Trash2, UserCircle } from "lucide-react";
import {
  deleteConversation,
  newConversation,
  selectConversation,
  setConversationAgent,
  setConversationActiveFeatureBranch,
  setConversationArchived,
  useActiveConversation,
  useConversations,
} from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { createAndActivateFeatureBranch } from "@/lib/agent/create-feature-branch";

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
      // UNSCOPED, and it says so. A `window.prompt` cannot hold a scope picker,
      // and this path exists to pick an EXISTING branch — the agent creates
      // scoped ones through dev_branch_request, and Build Studio's tree has the
      // dialog. Unscoped couples BOS's own repos and never one of the user's, so
      // the failure mode is "user-apps was not branched", not "a stranger's
      // project was". Stating it beats a silent default.
      const name = window.prompt(
        "Feature branch name (kebab-case, up to 4 segments).\n\n" +
          "This branches BrowserOS's own repositories only. For work on a marketplace item or one of your " +
          "own repositories, start it from Build Studio, which asks what the work is on.",
        "",
      );
      if (!name) return;
      // The SAME create-and-activate Build Studio's tree uses
      // (create-feature-branch.ts). Both halves must happen together — a branch
      // created but not recorded leaves this dropdown unchanged — and two copies
      // of that pair is one too many.
      try {
        const { branch } = await createAndActivateFeatureBranch(name, conv.id);
        setBranches((b) => ({
          featureBranches: b.featureBranches.includes(branch) ? b.featureBranches : [branch, ...b.featureBranches],
        }));
      } catch (e) {
        window.alert((e as Error).message);
      }
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

  // Archived conversations are filtered out of the dropdown entirely (FR-008
  // as amended): the tidied list IS the point. Restoring one happens via the
  // shared read-only banner or the Assistant panel's Archived section — both
  // write the same shared flag, so it returns here automatically.
  const defaults = conversations.filter((c) => !c.archived);
  const activeConv = conversations.find((c) => c.id === activeId);
  const activeArchived = activeConv?.archived === true;

  return (
    <span className="flex items-center gap-1 text-xs text-white/60">
      <label className="flex items-center gap-1.5" title="Active conversation">
        <MessageSquare size={14} className="text-white/50" />
        <select
          value={activeId}
          data-testid="conversation-selector"
          onChange={(e) => void onChange(e.target.value)}
          className="max-w-[240px] rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs text-white/85 outline-none focus:border-white/30"
        >
          {defaults.length === 0 && <option value="">No conversations</option>}
          {defaults.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
          <option value="__new__">New conversation...</option>
        </select>
      </label>
      <button
        onClick={() => {
          if (activeConv && !activeArchived) void setConversationArchived(activeConv.id, true);
        }}
        disabled={!activeConv || activeArchived}
        title="Archive this conversation"
        data-testid="conversation-archive-button"
        className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/40"
      >
        <Archive size={12} />
      </button>
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
