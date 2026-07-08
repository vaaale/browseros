"use client";

import { Plus } from "lucide-react";
import type { AgentMeta } from "./types";

export interface AgentListProps {
  agents: AgentMeta[];
  /** The globally-active agent (the main chat's personality). */
  activeAgentId: string;
  /** The row currently highlighted in the master pane. */
  selectedAgentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

/**
 * Left master pane of the Agent Settings master-detail layout. Fixed 260px
 * width, scroll-independent from the right details pane.
 */
export function AgentList({ agents, activeAgentId, selectedAgentId, onSelect, onNew }: AgentListProps) {
  return (
    <div className="flex w-[260px] shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
      <div className="shrink-0 border-b border-white/10 bg-white/5 px-3 py-2.5">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          Agent Personalities
        </h2>
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-xs font-medium hover:bg-white/15"
        >
          <Plus size={12} className="shrink-0" />
          New Agent
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {agents.map((a) => (
          <AgentListItem
            key={a.id}
            agent={a}
            isActive={a.id === activeAgentId}
            isSelected={a.id === selectedAgentId}
            onClick={() => onSelect(a.id)}
          />
        ))}
        {agents.length === 0 && (
          <p className="px-2 py-3 text-xs text-white/40">No agents yet.</p>
        )}
      </div>
    </div>
  );
}

interface AgentListItemProps {
  agent: AgentMeta;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
}

function AgentListItem({ agent, isActive, isSelected, onClick }: AgentListItemProps) {
  return (
    <button
      onClick={onClick}
      className={`mb-1 block w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
        isSelected
          ? "border-violet-500/70 bg-white/10"
          : "border-transparent hover:border-white/20 hover:bg-white/5"
      }`}
    >
      <div className="mb-0.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
          {agent.name}
        </span>
        {isActive && (
          <span className="shrink-0 rounded bg-violet-500/25 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-violet-200">
            Active
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-[11px] leading-snug text-white/50">
        {agent.description || <span className="italic text-white/30">No description</span>}
      </p>
    </button>
  );
}
