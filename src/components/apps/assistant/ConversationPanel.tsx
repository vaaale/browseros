"use client";

import { Plus, Trash2, MessageSquare } from "lucide-react";
import {
  useConversations,
  newConversation,
  selectConversation,
  deleteConversation,
  DEFAULT_GROUP,
} from "@/lib/agent/conversations";

export function ConversationPanel({ group = DEFAULT_GROUP }: { group?: string }) {
  const { conversations, activeId } = useConversations(group);

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
      <div className="flex items-center justify-between px-2 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-white/40">Chats</span>
        <button onClick={() => void newConversation(group)} title="New conversation" className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white">
          <Plus size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1.5 pb-2">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center gap-1.5 rounded px-2 py-1.5 text-xs ${
              activeId === c.id ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
            }`}
          >
            <MessageSquare size={12} className="shrink-0 text-white/40" />
            <button onClick={() => selectConversation(c.id)} className="flex-1 truncate text-left">
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
        ))}
      </div>
    </div>
  );
}
