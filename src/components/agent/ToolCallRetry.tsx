"use client";

import { useEffect, useRef } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";

// Resilience for inference servers that intermittently emit tool calls as TEXT
// (e.g. `<tool_call>…` / `<function=…>`) instead of native function calls — those
// don't execute. When we detect that in a reply the model JUST produced, we
// silently regenerate the turn via reloadMessages (drops the failed reply and
// re-runs from the last user prompt — nothing is appended to the transcript).
//
// CRITICAL: only ever act on a reply generated live in this session, NEVER on
// messages that appeared because a conversation was loaded from disk. Loading a
// conversation must only populate the UI; reacting to restored messages here
// would call reloadMessages → runAgent and make the assistant "start working"
// on app open with no user input. We gate on the loading→idle transition: a
// real generation flips isLoading true→false, whereas a restore sets messages
// while isLoading stays false.
const LEAK = /<tool_call\b|<\/tool_call>|<function\s*=|<\|tool[_ ]?call\|>/i;
const MAX_RETRIES = 2;

// CopilotKit 1.61 renders AG-UI messages — plain objects. Text turns carry their
// text in `content`; tool calls/results don't, so a string `content` isolates
// text turns.
interface ChatMessage {
  id: string;
  role: string;
  content?: unknown;
}
type TextTurn = ChatMessage & { content: string };

export function ToolCallRetry() {
  const { messages, reloadMessages, isLoading } = useCopilotChatInternal();
  // True only on the render where a live generation just finished. A conversation
  // load never sets this (it happens while idle), so restored messages are ignored.
  const wasLoading = useRef(false);
  const handledId = useRef<string | null>(null);
  const lastHumanId = useRef<string | null>(null);
  const retries = useRef(0);

  useEffect(() => {
    const justFinished = wasLoading.current && !isLoading;
    wasLoading.current = isLoading;
    if (isLoading || !justFinished) return;
    if (!Array.isArray(messages)) return;

    // Keep only text-bearing user/assistant turns (skip tool calls and results).
    const texts = (messages as unknown as ChatMessage[]).filter(
      (m): m is TextTurn => (m.role === "assistant" || m.role === "user") && typeof m.content === "string",
    );
    const lastReversed = <T,>(arr: T[], pred: (x: T) => boolean): T | undefined => {
      for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
      return undefined;
    };

    // A new human message starts a fresh retry budget. (Regenerating reuses the
    // existing user message, so its id is unchanged and the budget is preserved.)
    const lastUser = lastReversed(texts, (m) => m.role === "user");
    if (lastUser && lastUser.id !== lastHumanId.current) {
      lastHumanId.current = lastUser.id;
      retries.current = 0;
    }

    const last = texts[texts.length - 1];
    if (!last || last.role !== "assistant" || last.id === handledId.current) return;
    handledId.current = last.id;

    if (LEAK.test(last.content) && retries.current < MAX_RETRIES && typeof reloadMessages === "function") {
      retries.current += 1;
      void reloadMessages(last.id);
    }
  }, [messages, isLoading, reloadMessages]);

  return null;
}
