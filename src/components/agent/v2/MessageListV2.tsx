"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Brain, ChevronDown, ChevronRight, Pencil, RotateCcw, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { ChatMessage } from "@/lib/assistant/messages";
import { lastUserIndex, buildRetryPrompt } from "@/lib/assistant/messages";
import { useChatState, setEditing, type ToolCallView } from "@/lib/assistant/client/chat-store";
import { sendFeedback, sendMessage, deleteLastTurn } from "@/lib/assistant/client/run-client";
import { registerCard, toggleCard, useCardOpen, useCardScope } from "@/lib/agent/card-collapse";
import { ChatMarkdown } from "./ChatMarkdown";
import { ToolCallCard, type ToolCardData } from "./ToolCallCard";
import { ElicitationCards } from "./ElicitationCards";
import { shouldStickScroll } from "./stick-to-bottom";

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

// Takes only the specific slices of ChatState it needs (not the whole object)
// and is memoized, so a store update that only touches e.g. streamText/
// streamReasoning (i.e. every token of every streamed reply) does not
// re-render every historical message — only `toolCalls`/`running`/
// `lastUserMessage` changing does.
//
// `toolCalls` is the live map for the *entire* run and gets a new object
// reference on every tool_progress tick of whichever call is currently
// running (chat-store.ts), so a naive shallow-prop comparison would
// re-render every historical turn on every progress tick of any call,
// anywhere in the conversation. The custom comparator below only looks at
// the entries this specific message's own tool calls care about.
const AssistantTurn = memo(function AssistantTurn({
  message,
  toolCalls,
  running,
  lastUserMessage,
  resultsByCall,
  conversationId,
  agentId,
  isLast,
}: {
  message: ChatMessage;
  toolCalls: Record<string, ToolCallView>;
  running: boolean;
  lastUserMessage: ChatMessage | undefined;
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
  const cards = cardsFor(message, resultsByCall, toolCalls);
  const rating = message.feedback?.rating;

  const handleRegenerate = () => {
    if (running || !lastUserMessage) return;
    void sendMessage(conversationId, agentId, lastUserMessage.content ?? "", { editOfMessageId: lastUserMessage.id });
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
          {isLast && !running && (
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
},
(prev, next) => {
  if (
    prev.message !== next.message ||
    prev.running !== next.running ||
    prev.lastUserMessage !== next.lastUserMessage ||
    prev.resultsByCall !== next.resultsByCall ||
    prev.conversationId !== next.conversationId ||
    prev.agentId !== next.agentId ||
    prev.isLast !== next.isLast
  ) {
    return false;
  }
  if (prev.toolCalls === next.toolCalls) return true;
  const ids = next.message.toolCalls?.map((tc) => tc.id) ?? [];
  return ids.every((id) => prev.toolCalls[id] === next.toolCalls[id]);
});

/** Error card for a failed model turn (message.error). Shows the provider error
 *  and — while it's the last message and no run is active — a Retry (edit-resubmit
 *  the last user turn with a summary of the failed attempt) and a Cancel that
 *  just dismisses the card. */
const ErrorCard = memo(function ErrorCard({
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
});

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Whether we should auto-scroll to the bottom on the next update. Starts
  // true (new conversation), and is kept in sync with the user's own scroll
  // position so that scrolling up to reread earlier content isn't fought by
  // the next streamed token/tool event snapping the view back down.
  const stickToBottomRef = useRef(true);
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

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
  // Passed to AssistantTurn instead of the whole messages array, so it only
  // needs to re-render on a new last-user-message, not on every token.
  const lastUserMessage = useMemo(
    () => [...state.messages].reverse().find((m) => m.role === "user"),
    [state.messages],
  );
  const liveStream = state.running && (state.streamText || state.streamReasoning);
  const liveSplit = liveStream ? splitReasoning(state.streamText) : undefined;

  // Virtualized: a long-running conversation can accumulate thousands of
  // messages, and mounting every one of them (even memoized) keeps a
  // proportionally huge layout tree alive — every operation that touches
  // layout anywhere on the page (notably the chat input's own auto-resize,
  // which reads scrollHeight) pays for that size on every keystroke. Only
  // messages near the viewport (+ overscan) are ever mounted; item height is
  // measured per-message (they vary wildly: a one-line user message vs. a
  // long markdown reply with tool cards), not estimated/fixed.
  const rowVirtualizer = useVirtualizer({
    count: state.messages.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => state.messages[index]?.id ?? index,
  });

  const toolCallCount = Object.keys(state.toolCalls).length;
  // Virtualized items start at `estimateSize` (96px) until the virtualizer
  // actually measures them, so `getTotalSize()` (and thus where "the bottom"
  // really is) keeps shifting for a few renders after messages first mount —
  // include it in the deps so this re-snaps to the bottom as those real
  // measurements land, instead of settling wherever the initial estimate put it.
  const totalSize = rowVirtualizer.getTotalSize();
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // scrollToIndex is virtualizer-measurement-aware (accurate even before the
    // spacer's overall height estimate has settled); scrollIntoView on the
    // trailing ref then covers whatever sits after the last message (live
    // stream text, elicitation cards) that scrollToIndex alone can't see.
    if (state.messages.length > 0) rowVirtualizer.scrollToIndex(state.messages.length - 1, { align: "end" });
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length, state.streamText, state.streamReasoning, toolCallCount, totalSize, rowVirtualizer]);

  // This container's own height changes for reasons that have nothing to do
  // with new messages — most commonly, the input box below it (a flex
  // sibling) growing/shrinking as the user types a multi-line draft. scrollTop
  // is anchored from the top, so when the container shrinks, the bottom edge
  // of the viewport rides up over the latest messages instead of the view
  // staying put — read by the user as the conversation "jumping" while they
  // type. If they were pinned to the bottom, re-pin on every such resize, not
  // just on new content.
  //
  // A callback ref, not a `useEffect(..., [])`: this component renders a
  // loading/empty placeholder (no container div at all) before the real
  // conversation view mounts, so an effect with an empty dependency array
  // would fire once against a still-null containerRef.current during that
  // placeholder render and never get a second chance to attach once the real
  // container appears.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const stickRafRef = useRef<number | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (stickRafRef.current !== null) {
      cancelAnimationFrame(stickRafRef.current);
      stickRafRef.current = null;
    }
    if (!node) return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      // Deferred to the next frame rather than read-then-written synchronously
      // in the callback: writing scrollTop here would itself be an in-callback
      // layout change, the canonical trigger for the browser's benign
      // "ResizeObserver loop completed with undelivered notifications"
      // notification (compounded by the virtualizer's own observers). One
      // rAF is coalesced per burst of resize notifications.
      if (stickRafRef.current !== null) return;
      stickRafRef.current = requestAnimationFrame(() => {
        stickRafRef.current = null;
        if (shouldStickScroll(stickToBottomRef.current, node.scrollTop, node.scrollHeight)) {
          node.scrollTop = node.scrollHeight;
        }
      });
    });
    ro.observe(node);
    resizeObserverRef.current = ro;
  }, []);

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

  // Extracted so the virtualizer can call it per visible index only — same
  // content as before, just no longer a direct .map() over every message.
  const renderMessage = (m: ChatMessage, i: number) => {
    if (m.role === "user") {
      const isEditable = i === lastUserIdx && !state.running;
      return (
        <div className="group flex justify-end" data-testid="user-message">
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
        <AssistantTurn
          message={m}
          toolCalls={state.toolCalls}
          running={state.running}
          lastUserMessage={lastUserMessage}
          resultsByCall={resultsByCall}
          conversationId={conversationId}
          agentId={agentId}
          isLast={i === lastAssistantIdx}
        />
      );
    }
    return null; // tool results render inside their assistant turn's cards
  };

  return (
    <div
      ref={setContainerRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto px-4 py-3"
      data-testid="chat-messages"
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const m = state.messages[virtualRow.index];
          const content = m ? renderMessage(m, virtualRow.index) : null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
              className={content ? "pb-3" : undefined}
            >
              {content}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
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
    </div>
  );
}
