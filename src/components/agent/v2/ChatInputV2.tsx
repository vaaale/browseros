"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Square, X } from "lucide-react";
import { useChatState, setEditing } from "@/lib/assistant/client/chat-store";
import { sendMessage, stopRun } from "@/lib/assistant/client/run-client";
import type { ToolDeclaration } from "@/lib/assistant/tools";

const MAX_ROWS = 5;

// v2 chat input: send / server-side stop / edit-resubmit. Stop is ONE HTTP
// call — the server owns the run, so there is no client latch, no kernel stop
// flag, no queued-handler suppression to manage here.
export function ChatInputV2({
  conversationId,
  agentId,
  surfaceTools,
  placeholder = "Type a message…",
  ensureConversation,
}: {
  conversationId: string;
  agentId: string;
  surfaceTools?: ToolDeclaration[];
  placeholder?: string;
  /** Called before sending when there is no conversation yet; returns the id. */
  ensureConversation?: () => Promise<string>;
}) {
  const state = useChatState(conversationId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const editingMessage = state.editingMessageId
    ? state.messages.find((m) => m.id === state.editingMessageId)
    : undefined;

  // Entering edit mode prefills the textarea with the message being edited
  // (derived-state reset during render; focus is the only effectful part).
  const [lastEditId, setLastEditId] = useState<string | undefined>();
  if (state.editingMessageId !== lastEditId) {
    setLastEditId(state.editingMessageId);
    if (editingMessage) setText(editingMessage.content ?? "");
  }
  useEffect(() => {
    if (state.editingMessageId) textareaRef.current?.focus();
  }, [state.editingMessageId]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight || "20") || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  }, []);

  const busy = state.running;
  const canSend = !busy && text.trim().length > 0;

  const send = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setError(undefined);
    requestAnimationFrame(autoResize);
    const convId = conversationId || (ensureConversation ? await ensureConversation() : "");
    if (!convId) return;
    const res = await sendMessage(convId, agentId, value, {
      editOfMessageId: editingMessage?.id,
      surfaceTools,
    });
    if (!res.ok) {
      setError(res.error);
      setText(value); // give the user their message back
    }
  }, [text, busy, conversationId, agentId, editingMessage, surfaceTools, ensureConversation, autoResize]);

  const cancelEdit = useCallback(() => setEditing(conversationId, undefined), [conversationId]);

  return (
    <div className="shrink-0 border-t border-white/10 px-3 py-2.5">
      {editingMessage && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200">
          <span className="min-w-0 flex-1 truncate">Editing your last message — sending will rewind the conversation to this point.</span>
          <button type="button" aria-label="Cancel edit" onClick={cancelEdit} className="rounded p-0.5 hover:bg-white/10">
            <X size={12} />
          </button>
        </div>
      )}
      {error && (
        <div className="mb-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
          {error}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 focus-within:border-white/20">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder}
          value={text}
          data-testid="chat-textarea"
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape" && editingMessage) cancelEdit();
          }}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-white/90 outline-none placeholder:text-white/30"
          style={{ overflowY: "auto" }}
        />
        {busy ? (
          <button
            type="button"
            aria-label="Stop"
            data-testid="chat-stop-button"
            onClick={() => void stopRun(conversationId)}
            className="rounded-lg bg-rose-500/80 p-1.5 text-white hover:bg-rose-500"
          >
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            data-testid="chat-send-button"
            disabled={!canSend}
            onClick={() => void send()}
            className="rounded-lg bg-[#5b8cff] p-1.5 text-white transition-opacity disabled:opacity-30"
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
