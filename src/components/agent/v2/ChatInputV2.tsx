"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Square, X, Paperclip, FileText } from "lucide-react";
import { useChatState, setEditing } from "@/lib/assistant/client/chat-store";
import { sendMessage, stopRun } from "@/lib/assistant/client/run-client";
import type { Attachment } from "@/lib/assistant/messages";
import { VoiceMicButton } from "@/components/voice/VoiceMicButton";

const MAX_ROWS = 5;
const ACCEPT = "image/*,application/pdf";

// Read a File into a raw base64 string (no data: prefix). Chunked to avoid a
// call-stack blowout when spreading a large Uint8Array.
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

// v2 chat input: send / server-side stop / edit-resubmit. Stop is ONE HTTP
// call — the server owns the run, so there is no client latch, no kernel stop
// flag, no queued-handler suppression to manage here.
export function ChatInputV2({
  conversationId,
  agentId,
  placeholder = "Type a message…",
  ensureConversation,
}: {
  conversationId: string;
  agentId: string;
  placeholder?: string;
  /** Called before sending when there is no conversation yet; returns the id. */
  ensureConversation?: () => Promise<string>;
}) {
  const state = useChatState(conversationId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(undefined);
    try {
      const next: Attachment[] = [];
      for (const file of Array.from(files)) {
        const data = await fileToBase64(file);
        const type: Attachment["type"] = file.type.startsWith("image/") ? "image" : "file";
        // Persist to the VFS (best-effort) so the attachment has a stable path;
        // never block sending on it.
        let vfsPath: string | undefined;
        try {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch("/api/attachments", { method: "POST", body: form }).then((r) => r.json());
          vfsPath = res?.vfsPath;
        } catch {
          /* upload is best-effort */
        }
        next.push({ type, mimeType: file.type || "application/octet-stream", data, name: file.name, vfsPath });
      }
      setAttachments((prev) => [...prev, ...next]);
    } finally {
      setUploading(false);
    }
  }, []);

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
  const canSend = !busy && !uploading && (text.trim().length > 0 || attachments.length > 0);

  const send = useCallback(async () => {
    const value = text.trim();
    if (busy || uploading || (!value && attachments.length === 0)) return;
    const sentAttachments = attachments;
    setText("");
    setAttachments([]);
    setError(undefined);
    requestAnimationFrame(autoResize);
    const convId = conversationId || (ensureConversation ? await ensureConversation() : "");
    if (!convId) return;
    const res = await sendMessage(convId, agentId, value, {
      editOfMessageId: editingMessage?.id,
      attachments: sentAttachments.length ? sentAttachments : undefined,
    });
    if (!res.ok) {
      setError(res.error);
      setText(value); // give the user their message back
      setAttachments(sentAttachments);
    }
  }, [text, busy, uploading, attachments, conversationId, agentId, editingMessage, ensureConversation, autoResize]);

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
      {(attachments.length > 0 || uploading) && (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="attachment-chips">
          {attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.06] py-0.5 pl-1 pr-0.5 text-[11px] text-white/70">
              {a.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element -- inline base64 data URI; next/image can't optimize it
                <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name ?? "image"} className="h-5 w-5 rounded object-cover" />
              ) : (
                <FileText size={12} className="text-white/50" />
              )}
              <span className="max-w-[140px] truncate">{a.name ?? a.mimeType}</span>
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                className="rounded p-0.5 hover:bg-white/10"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {uploading && <span className="text-[11px] text-white/40">Uploading…</span>}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 focus-within:border-white/20">
        <button
          type="button"
          aria-label="Attach file"
          data-testid="chat-attach-button"
          onClick={() => fileRef.current?.click()}
          className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white/70"
        >
          <Paperclip size={15} />
        </button>
        <VoiceMicButton
          conversationId={conversationId}
          agentId={agentId}
          ensureConversation={ensureConversation}
          onTranscript={(t) => {
            setText((prev) => (prev ? `${prev} ${t}` : t));
            requestAnimationFrame(autoResize);
          }}
        />
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
