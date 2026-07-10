"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Trash2, MessageSquare, Pencil } from "lucide-react";
import {
  useConversations,
  useAllConversations,
  newConversation,
  selectConversation,
  deleteConversation,
  renameConversation,
  type Conversation,
} from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

interface AgentMeta {
  id: string;
  name: string;
}

// ── Resizable shell ────────────────────────────────────────────────────────
const PANEL_MIN_W = 180;
const PANEL_MAX_W = 480;
const PANEL_DEFAULT_W = 240; // a little wider than the old fixed w-48 (192px)
const PANEL_WIDTH_KEY = "bos.convPanel.width";

/** Left panel shell with a draggable right edge. Width persists across sessions
 *  in localStorage and is clamped to [PANEL_MIN_W, PANEL_MAX_W]. */
function ResizablePanel({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(PANEL_DEFAULT_W);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Number.isFinite(saved) && saved >= PANEL_MIN_W && saved <= PANEL_MAX_W) setWidth(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width; // fresh closure per render — current width at drag start
    let lastWidth = startW;
    const onMove = (ev: MouseEvent) => {
      lastWidth = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, startW + (ev.clientX - startX)));
      setWidth(lastWidth);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(lastWidth));
      } catch {
        /* ignore */
      }
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-white/10 bg-white/[0.02]"
      style={{ width }}
    >
      {children}
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-sky-400/40"
      />
    </div>
  );
}

function humanize(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function ConvRow({ c, active, onPick }: { c: Conversation; active: boolean; onPick?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const startEditing = () => {
    setDraft(c.title);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };
  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== c.title) void renameConversation(c.id, title);
  };

  return (
    <div
      className={`group flex items-center gap-1.5 rounded px-2 py-1.5 text-xs ${
        active ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
      }`}
    >
      <MessageSquare size={12} className="shrink-0 text-white/40" />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
          aria-label="Conversation title"
          className="min-w-0 flex-1 rounded border border-white/20 bg-black/40 px-1 py-0.5 text-xs text-white outline-none focus:border-white/40"
        />
      ) : (
        <button
          onClick={() => {
            selectConversation(c.id);
            onPick?.();
          }}
          onDoubleClick={startEditing}
          title={`${c.title} (double-click to rename)`}
          className="flex-1 truncate text-left"
        >
          {c.title}
        </button>
      )}
      {!editing && (
        <button
          onClick={startEditing}
          title="Rename"
          className="rounded p-0.5 text-white/30 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
        >
          <Pencil size={11} />
        </button>
      )}
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
      <ResizablePanel>
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
      </ResizablePanel>
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
    <ResizablePanel>
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
    </ResizablePanel>
  );
}
