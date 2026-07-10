"use client";

// Per-conversation client chat state, fed by run events + loaded history.
// This replaces CopilotKit's agent.messages as the UI's source of truth: the
// SERVER owns the transcript; this store is a projection of (persisted
// messages) + (live run events), rebuilt losslessly on reconnect/replay.

import { useSyncExternalStore } from "react";
import type { ChatMessage } from "../messages";
import type { RunEvent, RunFinishReason } from "../run-events";

export interface ToolCallView {
  callId: string;
  name: string;
  args: string;
  execution: "server" | "frontend";
  status: "running" | "done" | "cancelled";
  result?: string;
  progress: unknown[];
}

export interface ChatState {
  conversationId: string;
  historyLoaded: boolean;
  messages: ChatMessage[];
  /** Live stream buffers for the in-flight assistant turn. */
  streamMessageId?: string;
  streamText: string;
  streamReasoning: string;
  /** Live tool-call status for the current run, keyed by callId. */
  toolCalls: Record<string, ToolCallView>;
  runId?: string;
  running: boolean;
  finishReason?: RunFinishReason;
  runError?: string;
  lastSeq: number;
  /** Edit-resubmit UI state: the last user message being edited, if any. */
  editingMessageId?: string;
}

function emptyState(conversationId: string): ChatState {
  return {
    conversationId,
    historyLoaded: false,
    messages: [],
    streamText: "",
    streamReasoning: "",
    toolCalls: {},
    running: false,
    lastSeq: 0,
  };
}

const states = new Map<string, ChatState>();
const listeners = new Map<string, Set<() => void>>();

function notify(conversationId: string) {
  for (const l of listeners.get(conversationId) ?? []) l();
}

export function getChatState(conversationId: string): ChatState {
  let s = states.get(conversationId);
  if (!s) {
    s = emptyState(conversationId);
    states.set(conversationId, s);
  }
  return s;
}

function update(conversationId: string, patch: Partial<ChatState>) {
  states.set(conversationId, { ...getChatState(conversationId), ...patch });
  notify(conversationId);
}

export function subscribeChat(conversationId: string, cb: () => void): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(cb);
  return () => set!.delete(cb);
}

export function useChatState(conversationId: string): ChatState {
  return useSyncExternalStore(
    (cb) => subscribeChat(conversationId, cb),
    () => getChatState(conversationId),
    () => getChatState(conversationId),
  );
}

export function setHistory(conversationId: string, messages: ChatMessage[]) {
  update(conversationId, { historyLoaded: true, messages });
}

export function setEditing(conversationId: string, messageId: string | undefined) {
  update(conversationId, { editingMessageId: messageId });
}

/** Stamp thumbs feedback locally (the server PATCH persists it). */
export function stampFeedbackLocal(conversationId: string, messageId: string, rating: "up" | "down") {
  const s = getChatState(conversationId);
  update(conversationId, {
    messages: s.messages.map((m) => (m.id === messageId ? { ...m, feedback: { rating, at: Date.now() } } : m)),
  });
}

export function markRunStarting(conversationId: string, runId: string) {
  // Reset live projection for a fresh run; replayed events rebuild it.
  update(conversationId, {
    runId,
    running: true,
    finishReason: undefined,
    runError: undefined,
    streamMessageId: undefined,
    streamText: "",
    streamReasoning: "",
    toolCalls: {},
    lastSeq: 0,
    editingMessageId: undefined,
  });
}

/** Apply one run event to the projection. Replay-safe: events at or below
 *  lastSeq are ignored, so attach(since=0) after a partial live tail is
 *  harmless. */
export function applyRunEvent(conversationId: string, e: RunEvent) {
  const s = getChatState(conversationId);
  if (e.seq <= s.lastSeq && e.runId === s.runId) return;
  const next: ChatState = { ...s, lastSeq: e.seq, runId: e.runId };

  switch (e.type) {
    case "run_started": {
      next.running = true;
      next.finishReason = undefined;
      next.runError = undefined;
      if (e.truncatedFromMessageId) {
        const idx = next.messages.findIndex((m) => m.id === e.truncatedFromMessageId);
        if (idx >= 0) next.messages = next.messages.slice(0, idx);
      }
      break;
    }
    case "text_delta": {
      if (next.streamMessageId !== e.messageId) {
        next.streamMessageId = e.messageId;
        next.streamText = "";
        next.streamReasoning = "";
      }
      next.streamText = next.streamText + e.delta;
      break;
    }
    case "reasoning_delta": {
      if (next.streamMessageId !== e.messageId) {
        next.streamMessageId = e.messageId;
        next.streamText = "";
        next.streamReasoning = "";
      }
      next.streamReasoning = next.streamReasoning + e.delta;
      break;
    }
    case "tool_call": {
      next.toolCalls = {
        ...next.toolCalls,
        [e.callId]: { callId: e.callId, name: e.name, args: e.args, execution: e.execution, status: "running", progress: [] },
      };
      break;
    }
    case "tool_progress": {
      const tc = next.toolCalls[e.callId];
      if (tc) next.toolCalls = { ...next.toolCalls, [e.callId]: { ...tc, progress: [...tc.progress, e.event] } };
      break;
    }
    case "tool_result": {
      const tc = next.toolCalls[e.callId];
      if (tc) next.toolCalls = { ...next.toolCalls, [e.callId]: { ...tc, status: "done", result: e.result } };
      break;
    }
    case "tool_cancelled": {
      const tc = next.toolCalls[e.callId];
      if (tc) next.toolCalls = { ...next.toolCalls, [e.callId]: { ...tc, status: "cancelled" } };
      break;
    }
    case "message": {
      // Finalized + persisted server-side; append unless replay already did.
      if (!next.messages.some((m) => m.id === e.message.id)) {
        next.messages = [...next.messages, e.message];
      }
      if (e.message.id === next.streamMessageId) {
        next.streamMessageId = undefined;
        next.streamText = "";
        next.streamReasoning = "";
      }
      break;
    }
    case "run_finished": {
      next.running = false;
      next.finishReason = e.reason;
      next.runError = e.error;
      // A cancelled mid-turn stream was discarded server-side — drop it here too.
      next.streamMessageId = undefined;
      next.streamText = "";
      next.streamReasoning = "";
      for (const [id, tc] of Object.entries(next.toolCalls)) {
        if (tc.status === "running") next.toolCalls = { ...next.toolCalls, [id]: { ...tc, status: "cancelled" } };
      }
      break;
    }
    case "step_started":
    case "state_patch":
      break;
  }

  states.set(conversationId, next);
  notify(conversationId);
}
