"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Pencil, RotateCcw, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { ChatMessage } from "@/lib/assistant/messages";
import { lastUserIndex, buildRetryPrompt } from "@/lib/assistant/messages";
import { useChatState, setEditing, type ChatState, type ToolCallView } from "@/lib/assistant/client/chat-store";
import { sendFeedback, sendMessage, deleteLastTurn } from "@/lib/assistant/client/run-client";
import { registerCard, toggleCard, useCardOpen, useCardScope } from "@/lib/agent/card-collapse";
import { ChatMarkdown } from "./ChatMarkdown";
import { ToolCallCard, type ToolCardData } from "./ToolCallCard";
import { ElicitationCards } from "./ElicitationCards";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function splitReasoning(content: string): { reasoning: string; answer: string; live: boolean } {
  const start = content.indexOf(THINK_OPEN);
  if (start === -1) return { reasoning: "", answer: content, live: false };
  const afterOpen = start + THINK_OPEN.length;
  const close = content.indexOf(THINK_CLOSE, afterOpen);
  if (close === -1) return { reasoning: content.slice(afterOpen).trim(), answer: "", live: true };
  const reasoning = content.slice(afterOpen, close).trim();
  const answer = content
    .slice(close + THINK_CLOSE.length)
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s+/, "");
  return { reasoning, answer, live: false };
}

function ReasoningBlock({ id, reasoning, live }: { id: string; reasoning: string; live: boolean }) {
  const scope = useCardScope();
  const cardId = `reason:${id}`;
  const open = useCardOpen(scope, cardId);
  useEffect(() => {
    if (reasoning) registerCard(scope, cardId);
  }, [reasoning, scope, cardId]);
  if (!reasoning) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
      <button
        type="button"
        onClick={() => toggleCard(scope, cardId)}
        aria-expanded={open}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-white/55"
      >
        {open ? <ChevronDown size={12} className="shrink-0 text-white/40" /> : <ChevronRight size={12} className="shrink-0 text-white/40" />}
        <Brain size={13} className={live ? "animate-pulse text-violet-300" : "text-white/40"} />
        {live ? "Thinking…" : "Reasoning"}
      </button>
      {open && (
        <div className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2.5 pt-1 text-[11px] leading-relaxed text-white/45">
          {reasoning}
        </div>
      )}
    </div>
  );
}

/** Tool-card data for an assistant message's calls: persisted transcript merged
 *  with the live run projection (status/progress before the result lands). */
function cardsFor(message: ChatMessage, resultsByCall: Map<string, string>, live: Record<string, ToolCallView>): ToolCardData[] {
  return (message.toolCalls ?? []).map((tc) => {
    const l = live[tc.id];
    const persisted = resultsByCall.get(tc.id);
    return {
      callId: tc.id,
      name: tc.function.name,
      args: l?.args ?? tc.function.arguments,
      status: l?.status ?? (persisted !== undefined ? "done" : "running"),
      result: l?.result ?? persisted,
      progress: l?.progress,
    };
  });
}

function AssistantTurn({
  message,
  state,
  resultsByCall,
  conversationId,
  agentId,
  isLast,
}: {
  message: ChatMessage;
  state: ChatState;
  resultsByCall: Map<string, string>;
  conversationId: string;
  agentId: string;
  isLast: boolean;
}) {
  // Prefer the explicit reasoning field (set when the model uses reasoning_delta
  // events). Fall back to extracting <think> tags from content for models that
  // embed thinking inline (DeepSeek/Qwen style).
  const fromContent = splitReasoning(message.content ?? "");
  const reasoning = message.reasoning ?? fromContent.reasoning;
  const answer = message.reasoning ? (message.content ?? "") : fromContent.answer;
  const live = message.reasoning ? false : fromContent.live;
  const cards = cardsFor(message, resultsByCall, state.toolCalls);
  const rating = message.feedback?.rating;

  const handleRegenerate = () => {
    if (state.running) return;
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    void sendMessage(conversationId, agentId, lastUser.content ?? "", { editOfMessageId: lastUser.id });
  };
  return (
    <div className="group" data-testid="assistant-message">
      <ReasoningBlock id={message.id} reasoning={reasoning} live={live} />
      {answer.trim() && <ChatMarkdown content={answer} />}
      {cards.map((c) => (
        <ToolCallCard key={c.callId} call={c} />
      ))}
      {answer.trim() && (
        <div className="mt-0.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="Good response"
            onClick={() => void sendFeedback(conversationId, message.id, "up")}
            className={`rounded p-1 hover:bg-white/10 ${rating === "up" ? "text-emerald-400" : "text-white/35 hover:text-white/70"}`}
          >
            <ThumbsUp size={13} />
          </button>
          <button
            type="button"
            aria-label="Poor response"
            onClick={() => void sendFeedback(conversationId, message.id, "down")}
            className={`rounded p-1 hover:bg-white/10 ${rating === "down" ? "text-rose-400" : "text-white/35 hover:text-white/70"}`}
          >
            <ThumbsDown size={13} />
          </button>
          {isLast && !state.running && (
            <button
              type="button"
              aria-label="Regenerate response"
              onClick={handleRegenerate}
              className="rounded p-1 text-white/35 hover:bg-white/10 hover:text-white/70"
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Error card for a failed model turn (message.error). Shows the provider error
 *  and — while it's the last message and no run is active — a Retry (edit-resubmit
 *  the last user turn with a summary of the failed attempt) and a Cancel that
 *  just dismisses the card. */
function ErrorCard({
  message,
  messages,
  conversationId,
  agentId,
  isLast,
  running,
}: {
  message: ChatMessage;
  messages: ChatMessage[];
  conversationId: string;
  agentId: string;
  isLast: boolean;
  running: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const handleRetry = () => {
    if (running) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    void sendMessage(conversationId, agentId, buildRetryPrompt(messages, message.content ?? ""), {
      editOfMessageId: lastUser.id,
    });
  };
  return (
    <div className="my-1 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs" data-testid="error-card">
      <div className="mb-1 font-medium text-rose-100">The model returned an error</div>
      <div className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-rose-200/90">{message.content}</div>
      {isLast && !running && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleRetry}
            data-testid="error-retry"
            className="rounded bg-rose-400/20 px-2.5 py-1 font-medium text-rose-100 hover:bg-rose-400/30"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            data-testid="error-cancel"
            className="rounded bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export function MessageListV2({
  conversationId,
  agentId,
  initialLabel,
}: {
  conversationId: string;
  agentId: string;
  initialLabel?: string;
}) {
  const state = useChatState(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const resultsByCall = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of state.messages) {
      if (m.role === "tool" && m.toolCallId) map.set(m.toolCallId, m.content ?? "");
    }
    return map;
  }, [state.messages]);

  const lastUserIdx = lastUserIndex(state.messages);
  const lastAssistantIdx = useMemo(() => {
    let last = -1;
    state.messages.forEach((m, i) => { if (m.role === "assistant") last = i; });
    return last;
  }, [state.messages]);
  const liveStream = state.running && (state.streamText || state.streamReasoning);
  const liveSplit = liveStream ? splitReasoning(state.streamText) : undefined;

  const toolCallCount = Object.keys(state.toolCalls).length;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length, state.streamText, state.streamReasoning, toolCallCount]);

  // No conversation selected yet (or still resolving one) — show the greeting,
  // not a loading state that would otherwise never clear.
  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/45">
        {initialLabel ?? "How can I help?"}
      </div>
    );
  }
  if (!state.historyLoaded) {
    return <div className="flex h-full items-center justify-center text-sm text-white/40">Loading conversation…</div>;
  }
  if (state.messages.length === 0 && !liveStream) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/45">
        {initialLabel ?? "How can I help?"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-3" data-testid="chat-messages">
      {state.messages.map((m, i) => {
        if (m.role === "user") {
          const isEditable = i === lastUserIdx && !state.running;
          return (
            <div key={m.id} className="group flex justify-end" data-testid="user-message">
              <div className="relative max-w-[85%] rounded-2xl rounded-br-sm bg-[#2a3550] px-3.5 py-2 text-sm leading-relaxed text-white/90">
                {(m.attachments?.length ?? 0) > 0 && (
                  <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                    {m.attachments!.map((a, ai) =>
                      a.type === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- inline base64 data URI; next/image can't optimize it
                        <img
                          key={ai}
                          src={`data:${a.mimeType};base64,${a.data}`}
                          alt={a.name ?? "image"}
                          className="max-h-40 rounded-lg border border-white/10 object-contain"
                        />
                      ) : (
                        <span key={ai} className="flex items-center gap-1 rounded-md border border-white/15 bg-black/20 px-1.5 py-1 text-[11px] text-white/70">
                          {a.name ?? a.mimeType}
                        </span>
                      ),
                    )}
                  </div>
                )}
                {m.content && <span className="whitespace-pre-wrap break-words">{m.content}</span>}
                {isEditable && (
                  <div className="absolute -left-7 top-1.5 flex flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      aria-label="Edit and resend"
                      data-testid="edit-message"
                      onClick={() => setEditing(conversationId, m.id)}
                      className="rounded p-1 text-white/35 hover:bg-white/10 hover:text-white/80"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete last turn"
                      data-testid="delete-turn"
                      title="Delete this turn (your message and its response)"
                      onClick={() => void deleteLastTurn(conversationId)}
                      className="rounded p-1 text-white/35 hover:bg-rose-500/20 hover:text-rose-300"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        }
        if (m.role === "assistant") {
          if (m.error) {
            return (
              <ErrorCard
                key={m.id}
                message={m}
                messages={state.messages}
                conversationId={conversationId}
                agentId={agentId}
                isLast={i === state.messages.length - 1}
                running={state.running}
              />
            );
          }
          return (
            <AssistantTurn key={m.id} message={m} state={state} resultsByCall={resultsByCall} conversationId={conversationId} agentId={agentId} isLast={i === lastAssistantIdx} />
          );
        }
        return null; // tool results render inside their assistant turn's cards
      })}

      {liveStream && (
        <div data-testid="live-stream">
          <ReasoningBlock
            id={state.streamMessageId ?? "live"}
            reasoning={state.streamReasoning || liveSplit?.reasoning || ""}
            live
          />
          {(liveSplit?.answer ?? "").trim() && <ChatMarkdown content={liveSplit!.answer} />}
        </div>
      )}
      {/* Backstop for a failed run that did NOT persist an error message (e.g. the
          run crashed outside a model turn); the normal model-turn error renders
          as an ErrorCard from its persisted message above. */}
      {state.finishReason === "error" && state.runError && !state.messages[state.messages.length - 1]?.error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          The run failed: {state.runError}
        </div>
      )}
      {state.finishReason === "cancelled" && (
        <div className="text-center text-[11px] text-white/35">Stopped.</div>
      )}
      <ElicitationCards conversationId={conversationId} agentId={agentId} />
      <div ref={bottomRef} />
    </div>
  );
}
