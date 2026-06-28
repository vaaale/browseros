"use client";

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

function humanize(group: string): string {
  return group
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

// `group` set → only that group's conversations (embedded chats).
// `group` unset → all conversations grouped/nested by group (the Assistant app);
// picking one calls onPickGroup so the host can switch the active group.
export function ConversationPanel({ group, onPickGroup }: { group?: string; onPickGroup?: (group: string) => void }) {
  const single = useConversations(group ?? DEFAULT_GROUP);
  const all = useAllConversations();

  if (group) {
    return (
      <div className="flex h-full w-48 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
        <div className="flex items-center justify-between px-2 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/40">Chats</span>
          <button
            onClick={() => void newConversation(group)}
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

  const groups = Array.from(new Set(all.conversations.map((c) => c.group))).sort((a, b) =>
    a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : a.localeCompare(b),
  );

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
      <div className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-white/40">Chats</div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-1.5 pb-2">
        {groups.map((g) => (
          <div key={g}>
            <div className="flex items-center justify-between px-1 py-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-white/35">{humanize(g)}</span>
              <button
                onClick={() => {
                  void newConversation(g);
                  onPickGroup?.(g);
                }}
                title={`New ${humanize(g)} conversation`}
                className="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="space-y-0.5">
              {all.conversations
                .filter((c) => c.group === g)
                .map((c) => (
                  <ConvRow key={c.id} c={c} active={all.activeByGroup[g] === c.id} onPick={() => onPickGroup?.(g)} />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
